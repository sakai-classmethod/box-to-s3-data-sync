// lib/box-to-s3-data-sync-stack.ts

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import type { Construct } from "constructs";

export interface BoxToS3DataSyncStackProps extends cdk.StackProps {
	/**
	 * 既存のS3バケット名
	 */
	bucketName: string;
	/**
	 * SSMパラメータ名
	 */
	ssmParameterKey: string;
	/**
	 * S3のプレフィックス
	 */
	destinationS3Prefix: string;
	/**
	 * Boxフォルダ ID
	 */
	boxFolderId: string;
	/**
	 * 環境名（dev, prod など）
	 */
	environment?: string;
	/**
	 * Bedrock Knowledge Base ID
	 */
	knowledgeBaseId: string;
	/**
	 * Bedrock Data Source ID
	 */
	dataSourceId: string;
	/**
	 * 同期ファイルのプレフィックス（配列）
	 */
	syncFilePrefixes: string[];
	/**
	 * 最大ファイルサイズ (MB)
	 */
	maxFileSizeMB: number;
}

export class BoxToS3DataSyncStack extends cdk.Stack {
	private readonly envName?: string;

	constructor(scope: Construct, id: string, props: BoxToS3DataSyncStackProps) {
		super(scope, id, props);

		this.envName = props.environment;

		// 既存のS3バケットを参照
		const dataBucket = s3.Bucket.fromBucketName(
			this,
			"ExistingBucket",
			props.bucketName,
		);

		// Lambda Layerを作成
		const dependenciesLayer = this.createDependenciesLayer();

		// Lambda関数をNodejsFunctionとして作成
		const boxToS3Function = new nodejs.NodejsFunction(this, "BoxToS3Function", {
			runtime: lambda.Runtime.NODEJS_20_X,
			handler: "handler",
			entry: path.join(__dirname, "../lambda/index.ts"),
			layers: [dependenciesLayer],
			memorySize: 1024,
			timeout: cdk.Duration.seconds(300),
			bundling: {
				externalModules: [
					// AWS SDKはレイヤーから提供されるためバンドルから除外
					"@aws-sdk/*",
					"@smithy/*",
					// Box SDKもレイヤーから提供されるため除外
					"box-typescript-sdk-gen",
				],
			},
			environment: {
				SSM_PARAM_NAME: props.ssmParameterKey,
				S3_BUCKET_NAME: dataBucket.bucketName,
				S3_PREFIX: props.destinationS3Prefix,
				BOX_FOLDER_ID: props.boxFolderId,
				MAX_FILE_SIZE_MB: props.maxFileSizeMB.toString(),
			},
		});

		// Lambda関数にS3アクセス権限を付与
		boxToS3Function.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ["s3:PutObject", "s3:GetObject"],
				resources: [`${dataBucket.bucketArn}/*`],
			}),
		);

		// Lambda関数にSSMパラメータ読み取り権限を付与
		boxToS3Function.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ["ssm:GetParameter"],
				resources: [
					`arn:aws:ssm:${this.region}:${this.account}:parameter/box/*`,
				],
			}),
		);

		// ステートマシンのログ設定
		const logGroup = new logs.LogGroup(this, "StepFunctionsLogGroup", {
			retention: logs.RetentionDays.ONE_MONTH,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		// Step Functions のステートマシン定義
		const stateMachine = new sfn.StateMachine(this, "BoxToS3SyncStateMachine", {
			definitionBody: sfn.DefinitionBody.fromFile(
				path.join(__dirname, "../step-functions/box-to-s3-sync.yaml"),
			),
			definitionSubstitutions: {
				BoxToS3FunctionArn: boxToS3Function.functionArn,
			},
			role: this.createStateMachineRole(boxToS3Function.functionArn),
			tracingEnabled: true,
			logs: {
				destination: logGroup,
				level: sfn.LogLevel.ALL,
			},
			timeout: cdk.Duration.hours(1),
		});

		// 日本時間のAM1:00に毎日実行するEventBridgeルールを作成
		// UTC時間に変換（日本時間はUTC+9）: JST 00:00 → UTC 15:00（前日）
		const scheduledRule = new events.Rule(this, "ScheduledRule", {
			description:
				"Box to S3 data synchronization process scheduled to run at 1:00 AM JST",
			schedule: events.Schedule.cron({
				minute: "0",
				hour: "15",
				day: "*",
				month: "*",
				year: "*",
			}),
		});

		// ステートマシンをターゲットとして設定
		scheduledRule.addTarget(
			new targets.SfnStateMachine(stateMachine, {
				input: events.RuleTargetInput.fromObject({
					intervalHours: 24, // 固定値として24時間を設定
					filePrefixes: props.syncFilePrefixes,
					KnowledgeBaseId: props.knowledgeBaseId,
					DataSourceId: props.dataSourceId,
				}),
			}),
		);

		// 出力値の設定
		new cdk.CfnOutput(this, "FunctionName", {
			value: boxToS3Function.functionName,
			description: "Box to S3 Lambda function name",
		});

		new cdk.CfnOutput(this, "BucketName", {
			value: dataBucket.bucketName,
			description: "S3 bucket used for data storage",
		});

		new cdk.CfnOutput(this, "StateMachineName", {
			value: stateMachine.stateMachineName,
			description: "Box to S3 Sync State Machine name",
		});

		new cdk.CfnOutput(this, "StateMachineArn", {
			value: stateMachine.stateMachineArn,
			description: "Box to S3 Sync State Machine ARN",
		});

		new cdk.CfnOutput(this, "ScheduledRuleName", {
			value: scheduledRule.ruleName,
			description: "Daily scheduled EventBridge rule name",
		});
	}

	// Lambda Layerを作成するメソッド
	private createDependenciesLayer(): lambda.LayerVersion {
		// 一時的なレイヤーディレクトリを作成
		const tmpDir = path.join(__dirname, "../dist");
		const nodejsDir = path.join(tmpDir, "nodejs");

		// ディレクトリが存在しない場合は作成
		if (!fs.existsSync(tmpDir)) {
			fs.mkdirSync(tmpDir, { recursive: true });
		}
		if (!fs.existsSync(nodejsDir)) {
			fs.mkdirSync(nodejsDir);
		}

		// 外部のpackage.jsonをコピー
		const sourcePackageJson = path.join(__dirname, "../layers/package.json");
		const targetPackageJson = path.join(nodejsDir, "package.json");

		fs.copyFileSync(sourcePackageJson, targetPackageJson);

		// 依存関係をインストール
		try {
			console.log("Installing Lambda Layer dependencies...");
			execSync("npm install --omit=dev", {
				cwd: nodejsDir,
				stdio: "inherit",
				env: { ...process.env, NODE_ENV: "production" },
			});
		} catch (error) {
			console.error("Failed to install dependencies:", error);
			throw error;
		}

		// Lambda Layerを作成
		return new lambda.LayerVersion(this, "DependenciesLayer", {
			code: lambda.Code.fromAsset(tmpDir),
			compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
			description: "AWS SDK v3 and Box SDK dependencies",
		});
	}

	// ステートマシンのIAMロールを作成するメソッド
	private createStateMachineRole(lambdaFunctionArn: string): iam.Role {
		const role = new iam.Role(this, "StateMachineRole", {
			assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
			description: "Role for Box to S3 Sync State Machine",
			// AWS管理ポリシーを使用
			managedPolicies: [
				iam.ManagedPolicy.fromAwsManagedPolicyName(
					"service-role/AWSLambdaBasicExecutionRole",
				),
				iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonBedrockFullAccess"),
			],
		});

		// Lambda関数を呼び出す権限 - fromFunctionAttributesを使用し、sameEnvironmentフラグを設定
		lambda.Function.fromFunctionAttributes(this, "BoxToS3FunctionForGrant", {
			functionArn: lambdaFunctionArn,
			sameEnvironment: true,
		}).grantInvoke(role);

		return role;
	}
}
