import * as fs from "fs";
import * as path from "path";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { Upload } from "@aws-sdk/lib-storage";
import type { Context, Handler } from "aws-lambda";
import { BoxClient, BoxJwtAuth, JwtConfig } from "box-typescript-sdk-gen";

// クライアントの初期化をハンドラー外で一度だけ行い、再利用する
const s3Client = new S3Client();
const ssmClient = new SSMClient();

/** イベント入力パラメータの型定義 */
type EventInput = {
	/** 何時間前までの更新データを同期対象とするか（指定なしの場合は全量同期） */
	intervalHours?: number | null;
	/** ファイル名のプレフィックス（文字列の配列） */
	filePrefixes?: string[];
	/** ページネーション用オフセット */
	offset?: number;
	/** 1回の取得件数の上限 */
	limit?: number;
};

/**
 * Box APIの型定義
 * @see https://ja.developer.box.com/reference/get-folders-id-items/
 */
type BoxItemType = "file" | "folder" | "web_link";

type BoxItemBase = {
	id: string;
	type: BoxItemType;
	name?: string;
};

/** ダウンロードしたファイル情報の型定義 */
type BoxFileWithPath = {
	id: string;
	name: string;
	path: string;
};

/** フィルタリング結果の型定義 */
type FilteredFilesResult = {
	files: Array<{ id: string; name: string }>;
	hasMore: boolean;
	nextOffset: number;
};

/**
 * 必須環境変数の存在を検証
 * @throws 必須環境変数が設定されていない場合
 */
const validateEnvVars = (): void => {
	const requiredEnvVars = [
		"SSM_PARAM_NAME",
		"S3_BUCKET_NAME",
		"BOX_FOLDER_ID",
		"MAX_FILE_SIZE_MB",
	];

	const missingVars = requiredEnvVars.filter(
		(varName) => !process.env[varName],
	);

	if (missingVars.length > 0) {
		throw new Error(
			`必須の環境変数が設定されていません: ${missingVars.join(", ")}`,
		);
	}
};

/**
 * Box APIクライアントを作成（クロージャで状態を保持）
 * @returns BoxClientインスタンス
 * @throws SSMパラメータ取得失敗時
 */
const createBoxClient = async (): Promise<BoxClient> => {
	const boxConfigParamName = process.env.SSM_PARAM_NAME!;

	const parameterCommand = new GetParameterCommand({
		Name: boxConfigParamName,
		WithDecryption: true,
	});

	const ssmResponse = await ssmClient.send(parameterCommand);

	if (!ssmResponse.Parameter || !ssmResponse.Parameter.Value) {
		throw new Error(`パラメータ値が見つかりません: ${boxConfigParamName}`);
	}

	const boxConfigJson = ssmResponse.Parameter.Value;
	const jwtConfig = JwtConfig.fromConfigJsonString(boxConfigJson);
	const jwtAuth = new BoxJwtAuth({ config: jwtConfig });
	const client = new BoxClient({ auth: jwtAuth });

	return client;
};

/**
 * ファイル名の拡張子からContent-Typeを判定する関数
 * @param fileName - ファイル名
 * @returns 適切なContent-Type文字列
 */
const getContentType = (fileName: string): string => {
	// ファイル名から拡張子を取得（大文字小文字を区別しない）
	const extension = fileName.toLowerCase().split('.').pop() || '';
	
	// 拡張子とContent-Typeのマッピング
	const contentTypeMap: Record<string, string> = {
		// PDFファイル
		'pdf': 'application/pdf',
		
		// Microsoft Word
		'doc': 'application/msword',
		'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
		
		// Microsoft Excel
		'xls': 'application/vnd.ms-excel',
		'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
		
		// Microsoft PowerPoint
		'ppt': 'application/vnd.ms-powerpoint',
		'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
		
		// テキストファイル
		'txt': 'text/plain',
		
		// 画像ファイル
		'jpg': 'image/jpeg',
		'jpeg': 'image/jpeg',
		'png': 'image/png',
		'gif': 'image/gif',
	};
	
	// マッピングから該当するContent-Typeを取得、見つからない場合はデフォルト値
	return contentTypeMap[extension] || 'application/octet-stream';
};

/**
 * プレフィックスから正規表現パターンを作成
 */
const createPrefixPattern = (
	prefix: string | string[] | null | undefined,
): RegExp | null => {
	if (!prefix) {
		return null;
	}

	const escapeRegExp = (s: string): string =>
		s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	if (Array.isArray(prefix)) {
		// 空配列の場合はnullを返す（フィルタリング無効）
		if (prefix.length === 0) {
			return null;
		}
		const pattern = `^(${prefix.map(escapeRegExp).join("|")})`;
		return new RegExp(pattern);
	}

	return new RegExp(`^${escapeRegExp(prefix)}`);
};

/**
 * 条件に一致するBoxファイルをフィルタリングして取得
 */
const getFilteredBoxFiles = async (
	params: EventInput,
): Promise<FilteredFilesResult> => {
	const client = await createBoxClient();
	const folderId = process.env.BOX_FOLDER_ID!;
	
	// ページネーションのためのパラメータ設定
	const offset = params.offset || 0;
	const limit = params.limit || 50;
	
	console.log(`フォルダ ${folderId} からファイルを取得します (offset=${offset}, limit=${limit})`);

	const folderItems = await client.folders.getFolderItems(folderId, {
		queryParams: {
			limit,
			offset
		}
	});

	if (!folderItems.entries || folderItems.entries.length === 0) {
		console.log("対象フォルダにファイルがありません");
		return { 
			files: [],
			hasMore: false,
			nextOffset: offset
		};
	}

	// フォルダからファイルのみを抽出
	const fileEntries = folderItems.entries.filter(
		(item: BoxItemBase) => item.type === "file",
	);
	console.log(`フォルダ内のファイル数: ${fileEntries.length}件`);

	// ページネーション情報の計算
	// Box APIから取得したファイル数が要求したlimit数と同じ場合のみ、まだファイルがある可能性がある
	const hasMore = fileEntries.length === limit;
	const nextOffset = offset + fileEntries.length;
	console.log(`次回取得用オフセット: ${nextOffset}、まだデータがあるか: ${hasMore}`);

	// ファイル名プレフィックスによるフィルタリング
	const prefixPattern = createPrefixPattern(params.filePrefixes);
	if (prefixPattern) {
		console.log(`ファイル名パターン: ${prefixPattern} でフィルタリングします`);
	}

	let filteredByName = fileEntries;
	if (prefixPattern) {
		filteredByName = fileEntries.filter(
			(file: BoxItemBase) => file.name && prefixPattern.test(file.name),
		);
	}

	// ファイルサイズによるフィルタリング準備
	const maxFileSizeMB = Number(process.env.MAX_FILE_SIZE_MB);
	const maxFileSizeBytes = maxFileSizeMB * 1024 * 1024;
	console.log(
		`最大ファイルサイズ: ${maxFileSizeMB}MB (${maxFileSizeBytes}バイト) でフィルタリングします`,
	);

	// 時間指定がない場合はファイルサイズのみでフィルタリング
	if (params.intervalHours === undefined || params.intervalHours === null) {
		const fileDetailsPromises = filteredByName.map(
			async (file: BoxItemBase) => {
				try {
					const fileDetail = await client.files.getFileById(file.id);

					if (fileDetail.size && fileDetail.size > maxFileSizeBytes) {
						console.log(
							`ファイル "${fileDetail.name}" (${fileDetail.size}バイト) はサイズ超過のためスキップします`,
						);
						return null;
					}

					return {
						id: fileDetail.id,
						name: fileDetail.name || "",
					};
				} catch (error) {
					console.error(
						`ファイル情報の取得に失敗しました - ID: ${file.id}:`,
						error,
					);
					return null;
				}
			},
		);

		const filteredFiles = (await Promise.all(fileDetailsPromises)).filter(
			(file): file is { id: string; name: string } => 
				file !== null && typeof file.name === 'string'
		);

		console.log(
			`フィルタリング結果: ${filteredFiles.length}件のファイルが対象です`,
		);
		return {
			files: filteredFiles,
			hasMore,
			nextOffset
		};
	}

	// 時間指定がある場合、時間とサイズの両方でフィルタリング
	const fileDetailsPromises = filteredByName.map(async (file: BoxItemBase) => {
		try {
			const fileDetail = await client.files.getFileById(file.id);

			// 更新時間の基準を計算
			const cutoffTime = new Date();
			cutoffTime.setUTCHours(cutoffTime.getUTCHours() - params.intervalHours!);

			// 更新時間でフィルタリング
			if (fileDetail.modifiedAt && fileDetail.modifiedAt.value) {
				const modifiedTime = new Date(fileDetail.modifiedAt.value);
				if (modifiedTime < cutoffTime) {
					return null; // 基準時間より古いファイルは除外
				}
			}

			// ファイルサイズでフィルタリング
			if (fileDetail.size && fileDetail.size > maxFileSizeBytes) {
				console.log(
					`ファイル "${fileDetail.name}" (${fileDetail.size}バイト) はサイズ超過のためスキップします`,
				);
				return null;
			}

			return {
				id: fileDetail.id,
				name: fileDetail.name || "",
			};
		} catch (error) {
			console.error(
				`ファイル情報の取得に失敗しました - ID: ${file.id}:`,
				error,
			);
			return null;
		}
	});

	const filteredFiles = (await Promise.all(fileDetailsPromises)).filter(
		(file): file is { id: string; name: string } => 
			file !== null && typeof file.name === 'string'
	);

	console.log(
		`フィルタリング結果: ${filteredFiles.length}件のファイルが対象です`,
	);
	return {
		files: filteredFiles,
		hasMore,
		nextOffset
	};
};

/**
 * Boxからファイルをダウンロード
 */
const downloadFiles = async (
	params: EventInput,
): Promise<BoxFileWithPath[]> => {
	const result = await getFilteredBoxFiles(params);
	const filteredFiles = result.files || [];

	if (filteredFiles.length === 0) {
		console.log("ダウンロード対象のファイルがありません");
		return [];
	}

	const client = await createBoxClient();

	// 並列処理数の制限
	const batchSize = 10;
	const results: BoxFileWithPath[] = [];

	for (let i = 0; i < filteredFiles.length; i += batchSize) {
		const batch = filteredFiles.slice(i, i + batchSize);
		const batchPromises = batch.map(
			async (file: { id: string; name: string }) => {
				const fileContent = await client.downloads.downloadFile(file.id);
				const filePath = path.join("/tmp", file.name);

				return new Promise<BoxFileWithPath>((resolve, reject) => {
					const fileWriteStream = fs.createWriteStream(filePath);

					fileWriteStream.on("error", (err: Error) => {
						console.error(`ファイル "${file.name}" の保存に失敗しました:`, err);
						reject(err);
					});

					fileWriteStream.on("finish", () => {
						console.log(`ファイル "${file.name}" を保存しました`);
						resolve({
							path: filePath,
							name: file.name,
							id: file.id,
						});
					});

					if (fileContent) {
						fileContent.pipe(fileWriteStream);
						fileContent.on("end", () => {
							fileWriteStream.end();
						});
					} else {
						fileWriteStream.end();
						console.error(`ファイル "${file.name}" のダウンロードに失敗しました: ストリームがありません`);
						reject(new Error("ファイルダウンロードストリームがありません"));
					}
				});
			},
		);

		const batchResults = await Promise.all(batchPromises);
		results.push(...batchResults);
	}

	return results;
};

/**
 * ダウンロードしたファイルをS3にアップロード
 */
const syncFilesToS3 = async (
	params: EventInput,
): Promise<{ uploadResults: any[]; hasMore: boolean; nextOffset: number }> => {
	const result = await getFilteredBoxFiles(params);
	const files = await downloadFiles(params);
	
	const { hasMore, nextOffset } = result;

	if (files.length === 0) {
		console.log("アップロード対象のファイルがありません");
		return { 
			uploadResults: [],
			hasMore,
			nextOffset 
		};
	}

	const prefix = process.env.S3_PREFIX;
	const bucketName = process.env.S3_BUCKET_NAME!;

	// 並列処理数を制限
	const batchSize = 10;
	const uploadResults = [];

	for (let i = 0; i < files.length; i += batchSize) {
		const batch = files.slice(i, i + batchSize);
		const batchPromises = batch.map(async (file: BoxFileWithPath) => {
			const fileStream = fs.createReadStream(file.path);
			console.log(`ファイル "${file.name}" をS3にアップロードします`);

			// S3_PREFIXが設定されている場合はプレフィックスを付ける、そうでなければファイル名のみ
			const key = prefix ? `${prefix}/${file.name}` : file.name;

			const upload = new Upload({
				client: s3Client,
				params: {
					Bucket: bucketName,
					Key: key,
					Body: fileStream,
					ContentType: getContentType(file.name),
					Metadata: {
						"box-file-id": String(file.id),
					},
				},
			});

			const result = await upload.done();
			fileStream.destroy();

			// 一時ファイルを削除
			try {
				fs.unlinkSync(file.path);
				console.log(`一時ファイル "${file.path}" を削除しました`);
			} catch (error) {
				// 一時ファイルの削除失敗は処理継続に影響しない
				console.warn(
					`一時ファイル "${file.path}" の削除に失敗しました（処理は継続されます）:`,
					error,
				);
			}

			return result;
		});

		const batchResults = await Promise.all(batchPromises);
		uploadResults.push(...batchResults);
	}

	return { uploadResults, hasMore, nextOffset };
};

/**
 * Lambda Handler関数 - Box上のファイルをS3に同期
 */
export const handler: Handler = async (event: any, context: Context) => {
	try {
		validateEnvVars();

		// イベント入力パラメータを取得してバリデーション
		const params: EventInput = {
			intervalHours:
				event.intervalHours === null
					? null
					: event.intervalHours !== undefined
						? Number.isNaN(Number(event.intervalHours))
							? undefined
							: Number(event.intervalHours)
						: undefined,
			filePrefixes: Array.isArray(event.filePrefixes) ? event.filePrefixes : undefined,
			offset: typeof event.offset === 'number' ? event.offset : 0,
			limit: typeof event.limit === 'number' ? event.limit : 50
		};

		// intervalHoursの値が正の数であることを確認
		if (
			params.intervalHours !== null &&
			params.intervalHours !== undefined &&
			params.intervalHours <= 0
		) {
			throw new Error(
				"無効なパラメータ: intervalHours は正の数である必要があります",
			);
		}

		console.log("EventInput:", params);

		const { uploadResults, hasMore, nextOffset } = await syncFilesToS3(params);
		
		console.log(
			`処理が完了しました: ${uploadResults.length}件のファイルを処理しました (hasMore=${hasMore}, nextOffset=${nextOffset})`
		);
		
		const nextParams = hasMore ? {
			intervalHours: params.intervalHours ?? null,
			filePrefixes: params.filePrefixes ?? undefined,
			offset: nextOffset,
			limit: params.limit
		} : null;
		
		return {
			statusCode: 200,
			body: JSON.stringify({
				message: hasMore ? "処理が継続中です" : "処理が正常に完了しました",
				status: hasMore ? "IN_PROGRESS" : "COMPLETE",
				processedFiles: uploadResults.length,
				params: params,
				nextInvocationParams: nextParams
			}),
		};
	} catch (error) {
		console.error("エラーが発生しました:", error);
		throw error;
	}
};
