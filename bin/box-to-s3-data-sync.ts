#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { BoxToS3DataSyncStack } from "../lib/box-to-s3-data-sync-stack";

const app = new cdk.App();

const argContext = 'environment';
const envKey = app.node.tryGetContext(argContext);
if (envKey == undefined)
  throw new Error(`Please specify environment with context option. ex) cdk deploy -c ${argContext}=dev`);
const envVals = app.node.tryGetContext(envKey);
if (envVals == undefined) throw new Error('Invalid environment.');

const env = { account: envVals['env']['account'], region: envVals['env']['region'] };

// スタックを作成
new BoxToS3DataSyncStack(app, `BoxToS3DataSyncStack${envKey}`, {
	env,
	bucketName: envVals.bucketName,
	ssmParamName: envVals.ssmParamName,
	s3Prefix: envVals.s3Prefix,
	boxFolderId: envVals.boxFolderId,
	maxFileSizeMB: envVals.maxFileSizeMB,
	knowledgeBaseId: envVals.knowledgeBaseId,
	dataSourceId: envVals.dataSourceId,
});
