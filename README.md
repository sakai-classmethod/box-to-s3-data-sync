# Box to S3 Data Sync

Boxの特定フォルダーから指定条件に一致するファイルをS3にダウンロードし同期します。
Amazon Bedrockナレッジベースへのデータ連携も可能です。

## 概要

このプロジェクトはAWS CDKを使用して以下のリソースをデプロイします：

1. Box API接続用のLambda関数
2. データ同期処理を実行するStep Functions
3. 必要なIAMロールとポリシー
4. 日次実行のEventBridgeスケジュール

## アーキテクチャ

![Box to S3 データ同期のアーキテクチャ図](./images/aws.png)

### 主要コンポーネント

- **AWS Lambda**: Box APIと連携してファイル取得・S3へのアップロードを実行
- **AWS Step Functions**: 同期ワークフローを管理
- **Amazon EventBridge**: 定期的なスケジュール実行を提供
- **Amazon S3**: 同期したファイルの保存先
- **AWS Systems Manager Parameter Store**: Box API認証情報の安全な保管

## セットアップと実行

### 前提条件

- AWS CLI、CDKがインストールされており、適切な権限を持つプロファイルが設定されていること
- Node.jsインストールされていること
- Box Developerアカウントと適切な権限を持つアプリケーションの作成

### 手順

1. リポジトリのクローンと依存関係のインストール
   ```bash
   git clone https://github.com/sakai-classmethod/box-to-s3-data-sync
   cd box-to-s3-data-sync
   npm ci
   ```

2. Boxアプリケーションの作成とJSONのダウンロード
   - [Box JWT認証の設定ガイド](https://ja.developer.box.com/guides/authentication/jwt/jwt-setup/)にしたがって、Boxアプリケーションを作成します
   - サーバー認証（JWT）を選択し、設定JSONファイルをダウンロードします
   - ダウンロードしたJSONファイルを`box_config.json`として保存します
   
  > [!IMPORTANT]
  > 開発者コンソールの「構成」タブで、アプリケーションアクセスを「App + Enterpriseアクセス」に設定してください。
  > 作成したBoxアプリケーションを同期対象のBoxフォルダーにコラボレーターとして招待し、ビューアー権限を付与してください。[コラボレーターの招待方法](https://support.box.com/hc/ja/articles/360043696854-%E3%82%B3%E3%83%A9%E3%83%9C%E3%83%AC%E3%83%BC%E3%82%BF%E3%81%AE%E6%8B%9B%E5%BE%85)や[権限レベルの詳細](https://support.box.com/hc/ja/articles/360044196413-%E3%82%B3%E3%83%A9%E3%83%9C%E3%83%AC%E3%83%BC%E3%82%BF%E3%81%AE%E6%A8%A9%E9%99%90%E3%83%AC%E3%83%99%E3%83%AB%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6)については、Boxのドキュメントを参照してください。

3. Box JWT設定をAWS Systems Managerパラメータストアにアップロード
   ```bash
   aws ssm put-parameter \
     --name "/box/jwt" \
     --type "SecureString" \
     --value file://./box_config.json \
     --overwrite \
     --no-cli-pager \
     --region us-west-2
   ```

4. `cdk.json`の設定
   `cdk.json`ファイルの`context`セクション内に異なる環境のパラメーターを設定します：
   
   ```json
   {
     "context": {
       "": {
         "bucketName": "your-data-source-bucket-name",
         "destinationS3Prefix": "docs",
         "ssmParameterKey": "/box/jwt",
         "boxFolderId": "your-box-folder-id",
         "maxFileSizeMB": 50,
         "knowledgeBaseId": "your-knowledge-base-id",
         "dataSourceId": "your-data-source-id",
         "syncFilePrefixes": ["sample", "sample2"],
         "env": {
           "account": "123456789012",
           "region": "us-west-2"
         }
       },
       "dev": {
         "bucketName": "your-dev-bucket-name",
         "ssmParameterKey": "/box/jwt",
         "destinationS3Prefix": "docs",
         "boxFolderId": "your-box-folder-id",
         "maxFileSizeMB": 50,
         "knowledgeBaseId": "your-knowledge-base-id",
         "dataSourceId": "your-data-source-id",
         "syncFilePrefixes": ["sample", "sample2"],
         "env": {
           "account": "123456789012",
           "region": "us-west-2"
         }
       }
     }
   }
   ```
   
   各パラメーターの説明：
   - `bucketName`: 同期されたファイルを保存するS3バケット名（ナレッジベースのデータソース）
   - `ssmParameterKey`: Box JWT設定が保存されているSSMパラメーター名（デフォルト値のままでもOK）
   - `destinationS3Prefix`: S3バケット内のフォルダプレフィックス
   - `boxFolderId`: 同期するBoxのフォルダーID（[確認方法](https://ja.developer.box.com/platform/appendix/locating-values/#%E3%82%B3%E3%83%B3%E3%83%84id)）
   - `maxFileSizeMB`: ダウンロード可能な最大ファイルサイズ（MB単位）。初期値50MBは[Amazon Bedrockナレッジベースの前提条件](https://docs.aws.amazon.com/ja_jp/bedrock/latest/userguide/knowledge-base-ds.html)に合わせています
   - `knowledgeBaseId`: Amazon Bedrockナレッジベースの識別子
   - `dataSourceId`: ナレッジベース内のデータソース識別子
   - `syncFilePrefixes`: 同期対象のファイル名プレフィックス（配列で複数指定可能）
   - `env`: AWSアカウントとリージョンの設定

5. デプロイ
   環境を指定してデプロイします。
   
   ```bash
   # デフォルト環境へデプロイ
   npm run cdk:deploy
   
   # 開発環境へデプロイ
   npm run cdk:deploy:dev
   ```

   環境を明示的に指定する場合は以下のようにします：
   
   ```bash
   npx cdk deploy -c environment=dev
   ```

## 実行方法

### 実行パラメーター

- **intervalHours**: 
  - 自動実行時: 24時間（EventBridge実行時は固定値）
  - 手動実行時: 何時間前までの更新ファイルを対象とするか指定（省略時は全ファイル）
- **filePrefixes**: ファイル名のプレフィックス（文字列の配列で指定）
- **KnowledgeBaseId**: Amazon BedrockナレッジベースのID（**必須**）
- **DataSourceId**: ナレッジベースのデータソースID（**必須**）

### AWS マネジメントコンソールから手動実行

- AWS Step Functionsコンソールにアクセス
- `BoxToS3SyncStateMachine` を選択
- 「実行」をクリックし、パラメーターを入力して実行
   
```json
{
  "intervalHours": 24,
  "filePrefixes": ["sample", "sample2"],
  "KnowledgeBaseId": "XXXXXXXX",
  "DataSourceId": "XXXXXXXX"
}
```
   
### EventBridgeによる自動実行

CDKデプロイ時に、毎日日本時間AM1:00に実行されるEventBridgeルールが自動的に作成されます。

- 実行時間: 毎日日本時間AM1:00（UTC 15:00）
- 入力パラメーター:
   
```json
{
  "intervalHours": 24,
  "filePrefixes": ["sample", "sample2"],
  "KnowledgeBaseId": "XXXXXXXX",
  "DataSourceId": "XXXXXXXX"
}
```
   
EventBridgeルールのスケジュールや入力パラメーターを変更する場合は、CDKコードを修正するかマネジメントコンソールから直接変更してください。

## ワークフロー詳細

### Step Functionsのステップ

1. **SyncBox**: Box to S3同期処理（Lambda関数を呼び出し）
   - Box認証
   - 対象ファイルの抽出（条件に基づくフィルタリング）
   - ファイルダウンロードとS3へのアップロード
   
2. **CheckNextPage**: ページネーションチェック
   - まだ処理すべきファイルがある場合は次の実行へ
   - 全ファイルの処理が完了した場合はBedrockのデータ同期へ

3. **NextSyncBox**: 次のページのパラメーター設定
   - 次のoffsetを設定して再度SyncBoxを実行

4. **SyncDataSource**: Bedrockナレッジベースのデータソース同期開始
   - S3バケットに保存されたデータに基づいてBedrockナレッジベースの同期ジョブを開始

### Box APIインテグレーション

このプロジェクトでは、Box TypeScript SDK (`box-typescript-sdk-gen`)を使用してBoxとの連携を行っています。

主な操作：
- JWT認証を使用したセキュアなアクセス
- フォルダー内のファイル一覧取得
- 条件によるファイルのフィルタリング
- ファイルのダウンロード
- ページネーション処理によるファイル数の多いフォルダーの対応

### ファイルフィルタリング条件

Boxフォルダーから以下の条件でファイルをフィルタリングします：

1. **ファイル名プレフィックス**（指定があれば）
2. **ファイルサイズ上限**（デフォルト50MB）
3. **更新日時**（指定された時間内に更新されたファイル）

## プロジェクト構造

```
.
├── bin/                  # CDKアプリケーションのエントリーポイント
├── images/               # ドキュメント用画像
├── lambda/               # Lambda関数のソースコード
├── layers/               # Lambda Layers関連ファイル
├── lib/                  # CDKスタック定義
└── step-functions/       # Step Functions定義ファイル
```

## トラブルシューティング

- **認証エラー**: Box JWT設定が正しいか、SSM Parameter Storeに正しくアップロードされているか確認してください
- **ファイルが同期されない**: フィルタリング条件（ファイルサイズ、プレフィックス、更新時間）を確認してください
- **権限エラー**: Boxアプリケーションが対象フォルダーに対する適切な権限を持っているか確認してください
- **ページネーションエラー**: 大量のファイルがある場合、Step Functionsの実行ログでoffsetとlimitパラメーターを確認してください