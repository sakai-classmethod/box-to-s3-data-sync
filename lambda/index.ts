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
	hoursAgo?: number | null;
	/** ファイル名のプレフィックス（単純な文字列または配列） */
	filePrefix?: string | string[];
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

/**
 * 必須環境変数の存在を検証
 * @throws 必須環境変数が設定されていない場合
 */
const validateEnvVars = (): void => {
	const requiredEnvVars = [
		"SSM_PARAM_NAME",
		"S3_BUCKET_NAME",
		"S3_PREFIX",
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
): Promise<{ id: string; name: string }[]> => {
	const client = await createBoxClient();
	const folderId = process.env.BOX_FOLDER_ID;

	const folderItems = await client.folders.getFolderItems(folderId);

	if (!folderItems.entries || folderItems.entries.length === 0) {
		console.log("対象フォルダにファイルがありません");
		return [];
	}

	// フォルダからファイルのみを抽出
	const fileEntries = folderItems.entries.filter(
		(item: BoxItemBase) => item.type === "file",
	);
	console.log(`フォルダ内のファイル数: ${fileEntries.length}件`);

	// ファイル名プレフィックスによるフィルタリング
	const prefixPattern = createPrefixPattern(params.filePrefix);
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
	if (params.hoursAgo === undefined || params.hoursAgo === null) {
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
						name: fileDetail.name,
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
			(
				file: { id: string; name: string } | null,
			): file is { id: string; name: string } => file !== null,
		);

		console.log(
			`フィルタリング結果: ${filteredFiles.length}件のファイルが対象です`,
		);
		return filteredFiles;
	}

	// 時間指定がある場合、時間とサイズの両方でフィルタリング
	const fileDetailsPromises = filteredByName.map(async (file: BoxItemBase) => {
		try {
			const fileDetail = await client.files.getFileById(file.id);

			// 更新時間の基準を計算
			const cutoffTime = new Date();
			cutoffTime.setUTCHours(cutoffTime.getUTCHours() - params.hoursAgo!);

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
				name: fileDetail.name,
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
		(
			file: { id: string; name: string } | null,
		): file is { id: string; name: string } => file !== null,
	);

	console.log(
		`フィルタリング結果: ${filteredFiles.length}件のファイルが対象です`,
	);
	return filteredFiles;
};

/**
 * Boxからファイルをダウンロード
 */
const downloadFiles = async (
	params: EventInput,
	context?: Context,
): Promise<BoxFileWithPath[]> => {
	const filteredFiles = await getFilteredBoxFiles(params);

	if (!filteredFiles || filteredFiles.length === 0) {
		console.log("ダウンロード対象のファイルがありません");
		return [];
	}

	const client = await createBoxClient();

	// 並列処理数の制限
	const batchSize = 10;
	const results: BoxFileWithPath[] = [];

	for (let i = 0; i < filteredFiles.length; i += batchSize) {
		// Lambda実行時間の制約を考慮
		if (
			context &&
			context.getRemainingTimeInMillis &&
			context.getRemainingTimeInMillis() < 30000
		) {
			console.log(
				`残り時間が少ないため処理を中断します。${filteredFiles.length - i}件未処理`,
			);
			break;
		}

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

					fileContent.pipe(fileWriteStream);
					fileContent.on("end", () => {
						fileWriteStream.end();
					});
				});
			},
		);

		const batchResults = await Promise.all(batchPromises);
		results.push(...batchResults);
	}

	return results;
};

/**
 * S3クライアントを作成
 */
const createS3Client = (): S3Client => {
	// グローバルに初期化されたクライアントを返す
	return s3Client;
};

/**
 * ダウンロードしたファイルをS3にアップロード
 */
const syncFilesToS3 = async (
	params: EventInput,
	context?: Context,
): Promise<any[]> => {
	const files = await downloadFiles(params, context);

	if (!files || files.length === 0) {
		console.log("アップロード対象のファイルがありません");
		return [];
	}

	const prefix = process.env.S3_PREFIX!;
	const bucketName = process.env.S3_BUCKET_NAME!;

	// 並列処理数を制限
	const batchSize = 10;
	const results = [];

	for (let i = 0; i < files.length; i += batchSize) {
		// Lambda実行時間の制約を考慮
		if (
			context &&
			context.getRemainingTimeInMillis &&
			context.getRemainingTimeInMillis() < 30000
		) {
			console.log(
				`残り時間が少ないため処理を中断します。${files.length - i}件未処理`,
			);
			break;
		}

		const batch = files.slice(i, i + batchSize);
		const batchPromises = batch.map(async (file: BoxFileWithPath) => {
			// グローバルなS3クライアントを直接使用
			const fileStream = fs.createReadStream(file.path);

			console.log(`ファイル "${file.name}" をS3にアップロードします`);

			const upload = new Upload({
				client: s3Client,
				params: {
					Bucket: bucketName,
					Key: `${prefix}/${file.name}`,
					Body: fileStream,
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
		results.push(...batchResults);
	}

	return results;
};

/**
 * Lambda Handler関数 - Box上のファイルをS3に同期
 */
export const handler: Handler = async (event: any, context: Context) => {
	try {
		validateEnvVars();

		// イベント入力パラメータを取得してバリデーション
		const params: EventInput = {
			hoursAgo:
				event.hoursAgo === null
					? null
					: event.hoursAgo !== undefined
						? Number.isNaN(Number(event.hoursAgo))
							? undefined
							: Number(event.hoursAgo)
						: undefined,
			filePrefix: event.filePrefix,
		};

		// hoursAgoの値が正の数であることを確認
		if (
			params.hoursAgo !== null &&
			params.hoursAgo !== undefined &&
			params.hoursAgo <= 0
		) {
			throw new Error(
				"無効なパラメータ: hoursAgo は正の数である必要があります",
			);
		}

		console.log("EventInput:", params);

		const result = await syncFilesToS3(params, context);
		console.log(
			"処理が完了しました:",
			result.length,
			"件のファイルを処理しました",
		);
		return {
			statusCode: 200,
			body: JSON.stringify({
				message: "処理が正常に完了しました",
				processedFiles: result.length,
				params: params,
			}),
		};
	} catch (error) {
		console.error("エラーが発生しました:", error);
		throw error;
	}
};
