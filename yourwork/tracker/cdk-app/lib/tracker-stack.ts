import * as path from 'path';
import * as fs from 'fs';
import { Duration, RemovalPolicy, Stack, StackProps, Tags, CfnOutput, Annotations } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';

export interface TrackerStackProps extends StackProps {
  environmentName: string;
  eventTtlDays: number;
  apiThrottleBurstLimit: number;
  apiThrottleRateLimit: number;
  errorAlarmThreshold: number;
  durationAlarmThreshold: number;
  notificationEmail?: string;
}

export class TrackerStack extends Stack {
  constructor(scope: Construct, id: string, props: TrackerStackProps) {
    super(scope, id, props);

    const isProduction = props.environmentName.toLowerCase() === 'prod';
    const accountId = Stack.of(this).account;

    const tagResource = (resource: Construct, component: string) => {
      Tags.of(resource).add('Environment', props.environmentName);
      Tags.of(resource).add('Project', 'MLEWTracker');
      Tags.of(resource).add('Component', component);
    };

    Tags.of(this).add('Environment', props.environmentName);
    Tags.of(this).add('Project', 'MLEWTracker');

    // DynamoDB Tables
    const eventsTable = new dynamodb.Table(this, 'EventsTable', {
      tableName: `mlew-events-${props.environmentName}`,
      partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestampEventId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: true,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    eventsTable.addGlobalSecondaryIndex({
      indexName: 'UserIndex',
      partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestampEventId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    eventsTable.addGlobalSecondaryIndex({
      indexName: 'DateIndex',
      partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    tagResource(eventsTable, 'Database');

    const aggregationsTable = new dynamodb.Table(this, 'AggregationsTable', {
      tableName: `mlew-aggregations-${props.environmentName}`,
      partitionKey: { name: 'applicationIdPeriod', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    tagResource(aggregationsTable, 'Database');

    const applicationsTable = new dynamodb.Table(this, 'ApplicationsTable', {
      tableName: `mlew-applications-${props.environmentName}`,
      partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    tagResource(applicationsTable, 'Database');

    // S3 Buckets
    const dashboardBucket = new s3.Bucket(this, 'DashboardBucket', {
      bucketName: `mlew-dashboard-${accountId}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      publicReadAccess: true,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'error.html',
      removalPolicy: RemovalPolicy.RETAIN,
    });
    dashboardBucket.addCorsRule({
      allowedHeaders: ['*'],
      allowedMethods: [s3.HttpMethods.GET],
      allowedOrigins: ['*'],
      maxAge: 3600,
    });
    tagResource(dashboardBucket, 'Storage');

    const sdkBucket = new s3.Bucket(this, 'SdkBucket', {
      bucketName: `mlew-sdk-${accountId}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      }),
      publicReadAccess: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    sdkBucket.addCorsRule({
      allowedHeaders: ['*'],
      allowedMethods: [s3.HttpMethods.GET],
      allowedOrigins: ['*'],
      maxAge: 3600,
    });
    tagResource(sdkBucket, 'Storage');

    const archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      bucketName: `mlew-archive-${accountId}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    archiveBucket.addLifecycleRule({
      id: 'archive-lifecycle',
      enabled: true,
      transitions: [
        {
          storageClass: s3.StorageClass.GLACIER,
          transitionAfter: Duration.days(90),
        },
      ],
    });
    tagResource(archiveBucket, 'Storage');

    // CloudFront Distributions
    const dashboardDistribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: new origins.S3Origin(dashboardBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
    });

    const sdkDistribution = new cloudfront.Distribution(this, 'SdkDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(sdkBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });

    tagResource(dashboardDistribution, 'Delivery');
    tagResource(sdkDistribution, 'Delivery');

    // SNS topic for alarms (production only)
    let alarmTopic: sns.Topic | undefined;
    if (isProduction && props.notificationEmail) {
      alarmTopic = new sns.Topic(this, 'AlarmTopic', {
        topicName: `mleww3-alarms-${props.environmentName}`,
        displayName: 'MLEWW3 Tracker Alarms',
      });
      alarmTopic.addSubscription(new snsSubs.EmailSubscription(props.notificationEmail));
      tagResource(alarmTopic, 'Monitoring');
    }

    // Lambda functions
    const bundling: lambdaNodejs.BundlingOptions = {
      externalModules: ['aws-sdk'],
      target: 'es2022',
      format: lambdaNodejs.OutputFormat.CJS,
      minify: true,
      sourcesContent: false,
    };

    const eventIngestionFunction = new lambdaNodejs.NodejsFunction(this, 'EventIngestionFunction', {
      functionName: `mleww3-event-ingestion-${props.environmentName}`,
      entry: path.join(__dirname, '..', '..', 'packages', 'lambdas', 'event-ingestion', 'src', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: Duration.seconds(30),
      bundling,
      environment: {
        ENVIRONMENT: props.environmentName,
        EVENTS_TABLE: eventsTable.tableName,
        APPLICATIONS_TABLE: applicationsTable.tableName,
        ARCHIVE_BUCKET: archiveBucket.bucketName,
        EVENT_TTL_DAYS: props.eventTtlDays.toString(),
      },
    });
    tagResource(eventIngestionFunction, 'Compute');

    const queryFunction = new lambdaNodejs.NodejsFunction(this, 'QueryFunction', {
      functionName: `mleww3-query-${props.environmentName}`,
      entry: path.join(__dirname, '..', '..', 'packages', 'lambdas', 'query', 'src', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 512,
      timeout: Duration.seconds(30),
      bundling,
      environment: {
        ENVIRONMENT: props.environmentName,
        EVENTS_TABLE: eventsTable.tableName,
        AGGREGATIONS_TABLE: aggregationsTable.tableName,
        APPLICATIONS_TABLE: applicationsTable.tableName,
      },
    });
    tagResource(queryFunction, 'Compute');

    const streamAggregationFunction = new lambdaNodejs.NodejsFunction(this, 'StreamAggregationFunction', {
      functionName: `mleww3-stream-aggregation-${props.environmentName}`,
      entry: path.join(
        __dirname,
        '..',
        '..',
        'packages',
        'lambdas',
        'stream-aggregation',
        'src',
        'index.ts'
      ),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 128,
      timeout: Duration.seconds(60),
      bundling,
      environment: {
        ENVIRONMENT: props.environmentName,
        AGGREGATIONS_TABLE: aggregationsTable.tableName,
      },
    });
    tagResource(streamAggregationFunction, 'Compute');

    eventsTable.grantReadWriteData(eventIngestionFunction);
    eventsTable.grantReadData(queryFunction);
    eventsTable.grantStreamRead(streamAggregationFunction);

    aggregationsTable.grantReadWriteData(streamAggregationFunction);
    aggregationsTable.grantReadData(queryFunction);

    applicationsTable.grantReadWriteData(eventIngestionFunction);
    applicationsTable.grantReadData(queryFunction);

    archiveBucket.grantWrite(eventIngestionFunction);

    eventIngestionFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
      })
    );

    // DynamoDB stream event source for aggregation
    streamAggregationFunction.addEventSource(
      new lambdaEventSources.DynamoEventSource(eventsTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        maxBatchingWindow: Duration.seconds(5),
        retryAttempts: 3,
      })
    );

    // API Gateway
    const restApi = new apigw.RestApi(this, 'AnalyticsApi', {
      restApiName: `mleww3-analytics-api-${props.environmentName}`,
      description: 'MLEWW3 Tracker Analytics API',
      deployOptions: {
        stageName: props.environmentName,
      },
      endpointConfiguration: {
        types: [apigw.EndpointType.REGIONAL],
      },
    });
    tagResource(restApi, 'API');

    const v1 = restApi.root.addResource('v1');
    const eventsResource = v1.addResource('events');
    const analyticsResource = v1.addResource('analytics');
    const applicationsResource = analyticsResource.addResource('applications');
    const appResource = analyticsResource.addResource('{appId}');
    const summaryResource = appResource.addResource('summary');
    const appEventsResource = appResource.addResource('events');

    const eventIngestionIntegration = new apigw.LambdaIntegration(eventIngestionFunction, {
      proxy: true,
    });
    const queryIntegration = new apigw.LambdaIntegration(queryFunction, {
      proxy: true,
    });

    eventsResource.addMethod('POST', eventIngestionIntegration, { apiKeyRequired: true });
    eventsResource.addMethod('OPTIONS', eventIngestionIntegration, { apiKeyRequired: false });

    applicationsResource.addMethod('GET', queryIntegration, { apiKeyRequired: true });
    summaryResource.addMethod('GET', queryIntegration, { apiKeyRequired: true });
    appEventsResource.addMethod('GET', queryIntegration, { apiKeyRequired: true });

    const apiKey = restApi.addApiKey('ApiKey', {
      apiKeyName: `mleww3-api-key-${props.environmentName}`,
      description: 'API Key for MLEW Tracker',
    });

    const usagePlan = restApi.addUsagePlan('UsagePlan', {
      name: `mleww3-usage-plan-${props.environmentName}`,
      description: 'Usage plan for MLEW Tracker API',
      throttle: {
        burstLimit: props.apiThrottleBurstLimit,
        rateLimit: props.apiThrottleRateLimit,
      },
      quota: {
        limit: 1_000_000,
        period: apigw.Period.MONTH,
      },
    });
    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({
      api: restApi,
      stage: restApi.deploymentStage,
    });

    // CloudWatch Dashboard & Alarms
    const apiCountMetric = new cw.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      statistic: 'Sum',
      period: Duration.minutes(5),
      dimensionsMap: { ApiName: restApi.restApiName },
    });
    const api4xxMetric = new cw.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '4XXError',
      statistic: 'Sum',
      period: Duration.minutes(5),
      dimensionsMap: { ApiName: restApi.restApiName },
    });
    const api5xxMetric = new cw.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5XXError',
      statistic: 'Sum',
      period: Duration.minutes(5),
      dimensionsMap: { ApiName: restApi.restApiName },
    });

    const lambdaInvocationMetric = eventIngestionFunction.metricInvocations({
      period: Duration.minutes(5),
      statistic: 'Sum',
    });
    const lambdaErrorMetric = eventIngestionFunction.metricErrors({
      period: Duration.minutes(5),
      statistic: 'Sum',
    });
    const lambdaDurationMetric = eventIngestionFunction.metricDuration({
      period: Duration.minutes(5),
      statistic: 'Average',
    });

    const dynamoReadCapacityMetric = new cw.Metric({
      namespace: 'AWS/DynamoDB',
      metricName: 'ConsumedReadCapacityUnits',
      statistic: 'Sum',
      period: Duration.minutes(5),
      dimensionsMap: { TableName: eventsTable.tableName },
    });
    const dynamoWriteCapacityMetric = new cw.Metric({
      namespace: 'AWS/DynamoDB',
      metricName: 'ConsumedWriteCapacityUnits',
      statistic: 'Sum',
      period: Duration.minutes(5),
      dimensionsMap: { TableName: eventsTable.tableName },
    });
    const dynamoSystemErrorsMetric = new cw.Metric({
      namespace: 'AWS/DynamoDB',
      metricName: 'SystemErrors',
      statistic: 'Sum',
      period: Duration.minutes(5),
      dimensionsMap: { TableName: eventsTable.tableName },
    });

    new cw.Dashboard(this, 'MonitoringDashboard', {
      dashboardName: `MLEWTracker-${props.environmentName}`,
      widgets: [
        [
          new cw.GraphWidget({
            title: 'API Gateway Metrics',
            left: [apiCountMetric],
            right: [api4xxMetric, api5xxMetric],
          }),
        ],
        [
          new cw.GraphWidget({
            title: 'Lambda Functions',
            left: [lambdaInvocationMetric, lambdaErrorMetric],
            right: [lambdaDurationMetric],
          }),
        ],
        [
          new cw.GraphWidget({
            title: 'DynamoDB Tables',
            left: [dynamoReadCapacityMetric, dynamoWriteCapacityMetric],
            right: [dynamoSystemErrorsMetric],
          }),
        ],
      ],
    });

    const highErrorRateAlarm = new cw.Alarm(this, 'HighErrorRateAlarm', {
      alarmName: `MLEWW3-HighErrorRate-${props.environmentName}`,
      alarmDescription: `High error rate detected in ${props.environmentName} environment`,
      metric: api5xxMetric,
      threshold: props.errorAlarmThreshold,
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    const highDurationAlarm = new cw.Alarm(this, 'HighDurationAlarm', {
      alarmName: `MLEWW3-HighDuration-${props.environmentName}`,
      alarmDescription: `High average duration detected in ${props.environmentName} environment`,
      metric: lambdaDurationMetric,
      threshold: props.durationAlarmThreshold,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    if (alarmTopic) {
      const alarmAction = new cwActions.SnsAction(alarmTopic);
      highErrorRateAlarm.addAlarmAction(alarmAction);
      highDurationAlarm.addAlarmAction(alarmAction);
    }

    // Dashboard & SDK deployments (if assets exist)
    const dashboardDistPath = path.join(__dirname, '..', '..', 'packages', 'dashboard', 'dist');
    if (fs.existsSync(dashboardDistPath)) {
      new s3deploy.BucketDeployment(this, 'DashboardDeployment', {
        sources: [s3deploy.Source.asset(dashboardDistPath)],
        destinationBucket: dashboardBucket,
        distribution: dashboardDistribution,
        distributionPaths: ['/*'],
        prune: true,
      });
    } else {
      // Provide a synth-time warning to remind build step.
      Annotations.of(this).addWarning(
        'Dashboard dist not found. Run `npm run build --workspace=packages/dashboard` before cdk deploy.'
      );
    }

    const sdkDistPath = path.join(__dirname, '..', '..', 'packages', 'tracker-sdk', 'dist');
    if (fs.existsSync(sdkDistPath)) {
      new s3deploy.BucketDeployment(this, 'SdkDeployment', {
        sources: [s3deploy.Source.asset(sdkDistPath)],
        destinationBucket: sdkBucket,
        distribution: sdkDistribution,
        distributionPaths: ['/*'],
        prune: true,
      });
    } else {
      Annotations.of(this).addWarning(
        'Tracker SDK dist not found. Run `npm run build --workspace=packages/tracker-sdk` before cdk deploy.'
      );
    }

    // Outputs
    new CfnOutput(this, 'ApiEndpoint', {
      description: 'Analytics API Endpoint',
      value: `${restApi.url}v1/`,
      exportName: `${Stack.of(this).stackName}-ApiEndpoint`,
    });

    new CfnOutput(this, 'ApiKeyId', {
      description: 'API Key ID',
      value: apiKey.keyId,
      exportName: `${Stack.of(this).stackName}-ApiKeyId`,
    });

    new CfnOutput(this, 'DashboardURL', {
      description: 'Dashboard CloudFront URL',
      value: dashboardDistribution.distributionDomainName,
      exportName: `${Stack.of(this).stackName}-DashboardURL`,
    });

    new CfnOutput(this, 'DashboardBucketName', {
      description: 'Dashboard S3 Bucket Name',
      value: dashboardBucket.bucketName,
      exportName: `${Stack.of(this).stackName}-DashboardBucket`,
    });

    new CfnOutput(this, 'SdkBucketName', {
      description: 'Tracker SDK S3 Bucket Name',
      value: sdkBucket.bucketName,
      exportName: `${Stack.of(this).stackName}-SdkBucket`,
    });

    new CfnOutput(this, 'SdkDistributionDomain', {
      description: 'Tracker SDK CloudFront URL',
      value: sdkDistribution.distributionDomainName,
      exportName: `${Stack.of(this).stackName}-SdkDistributionDomain`,
    });

    new CfnOutput(this, 'EventsTableName', {
      description: 'Events DynamoDB Table Name',
      value: eventsTable.tableName,
      exportName: `${Stack.of(this).stackName}-EventsTable`,
    });

    new CfnOutput(this, 'ArchiveBucketName', {
      description: 'Archive S3 Bucket Name',
      value: archiveBucket.bucketName,
      exportName: `${Stack.of(this).stackName}-ArchiveBucket`,
    });
  }
}
