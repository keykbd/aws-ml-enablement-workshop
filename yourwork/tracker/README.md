# MLEW Tracker

ML Enablement Workshop で作成したモックアプリケーションの反応を計測するための、Webアナリティクス追跡システムです。

## 📦 パッケージ構成

- **tracker-sdk**: Webサイトに埋め込むJavaScript SDK
- **dashboard**: アナリティクスダッシュボード（React）
- **lambdas**: Lambda 関数のソースコード（ワークスペース単位で管理）

## 🚀 デプロイ方法

MLEW Tracker は CloudFormation テンプレート `MLEWTrackerDeploymentStack.yaml` を用いたワンクリックデプロイに統一されています。スタックを作成すると、付属の CodeBuild プロジェクトがリポジトリをクローンし、Lambda・ダッシュボード・SDK のビルドと本番配置まで自動で実行します。

```bash
# CloudFormation テンプレートによるデプロイ
aws cloudformation deploy \
  --template-file MLEWTrackerDeploymentStack.yaml \
  --stack-name mlew-tracker \
  --parameter-overrides NotificationEmailAddress=your-email@example.com \
  --capabilities CAPABILITY_IAM
```

パイプラインで行われる主な処理:
- `npm ci` と `npm run package:lambdas` で Lambda 関数をビルドし、S3 へアップロード
- `npm run build --workspace=packages/dashboard` で React ダッシュボードをビルドし、CloudFront + S3 へ配置
- `npm run build --workspace=packages/tracker-sdk` でブラウザ SDK をビルドし、専用 CloudFront + S3 へ配置
- `aws cloudformation deploy --template-file MLEWTrackerStack.yaml` で API Gateway / DynamoDB / CloudFront 構成を同期

デプロイ完了後、SNS 通知メールおよび CodeBuild の `deployment-info.txt` から以下を確認できます。
- **API Endpoint**: API ゲートウェイの URL
- **API Key**: API 認証用キー
- **Dashboard URL**: ダッシュボードの CloudFront ドメイン
- **Tracker SDK URL**: SDK を配信する CloudFront ドメイン

### 2. Webサイトへの統合

デプロイ完了後、出力されたAPI情報を使用してSDKを統合します：

```html
<!-- MLEW Tracker SDK -->
<script src="https://your-cdn-url/tracker-sdk.js"></script>
<script>
  const tracker = new MLEWTracker.Tracker({
    applicationId: 'my-app',
    applicationName: 'My Application',
    apiEndpoint: 'https://your-api.amazonaws.com/dev/',  // デプロイ時に出力された値
    apiKey: 'YOUR_API_KEY',  // デプロイ時に出力された値
    autoTrack: true
  });
</script>
```

### 3. ダッシュボードでデータ確認

デプロイ後に表示されるDashboard URLにアクセスしてデータが確認可能です。
