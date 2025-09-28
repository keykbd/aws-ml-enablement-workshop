#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TrackerStack, TrackerStackProps } from '../lib/tracker-stack';

const app = new cdk.App();

const environmentName =
  process.env.Environment ??
  process.env.ENVIRONMENT ??
  (app.node.tryGetContext('environment') as string | undefined) ??
  'dev';

const parseNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const trackerProps: TrackerStackProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  environmentName,
  eventTtlDays: parseNumber(
    process.env.EventTtlDays ?? (app.node.tryGetContext('eventTtlDays') as string | undefined),
    30
  ),
  apiThrottleBurstLimit: parseNumber(
    process.env.ApiThrottleBurstLimit ??
      (app.node.tryGetContext('apiThrottleBurstLimit') as string | undefined),
    5000
  ),
  apiThrottleRateLimit: parseNumber(
    process.env.ApiThrottleRateLimit ??
      (app.node.tryGetContext('apiThrottleRateLimit') as string | undefined),
    10000
  ),
  errorAlarmThreshold: parseNumber(
    process.env.ErrorAlarmThreshold ??
      (app.node.tryGetContext('errorAlarmThreshold') as string | undefined),
    100
  ),
  durationAlarmThreshold: parseNumber(
    process.env.DurationAlarmThreshold ??
      (app.node.tryGetContext('durationAlarmThreshold') as string | undefined),
    10000
  ),
  notificationEmail:
    process.env.NOTIFICATION_EMAIL ??
    process.env.NotificationEmail ??
    process.env.NotificationEmailAddress ??
    (app.node.tryGetContext('notificationEmail') as string | undefined),
};

new TrackerStack(app, `MLEWTrackerStack-${environmentName}`, trackerProps);
