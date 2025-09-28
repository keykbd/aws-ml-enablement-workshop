#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const lambdasDir = path.join(repoRoot, 'packages', 'lambdas');
const bucket = process.env.LAMBDA_CODE_BUCKET;
const keepLocalZips = process.env.KEEP_LAMBDA_ZIPS === 'true';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function prepareLambdaDir(dirPath, lambdaName) {
  const nodeModulesPath = path.join(dirPath, 'node_modules');
  if (existsSync(nodeModulesPath)) {
    rmSync(nodeModulesPath, { recursive: true, force: true });
  }

  const zipPath = path.join(dirPath, `${lambdaName}.zip`);
  if (existsSync(zipPath)) {
    rmSync(zipPath, { force: true });
  }
}

function zipLambda(dirPath, lambdaName) {
  const zipPath = path.join(dirPath, `${lambdaName}.zip`);
  const entries = ['.'];
  runCommand('zip', ['-rq', zipPath, ...entries], { cwd: dirPath });
  return zipPath;
}

function uploadZip(zipPath, lambdaName) {
  assert(bucket, 'LAMBDA_CODE_BUCKET environment variable must be set to upload zips.');
  const key = `lambda-packages/${lambdaName}.zip`;
  runCommand('aws', ['s3', 'cp', zipPath, `s3://${bucket}/${key}`], { cwd: repoRoot });
}

function buildLambda(dirent) {
  const lambdaName = dirent.name;
  const lambdaPath = path.join(lambdasDir, lambdaName);

  console.log(`\n=== Packaging Lambda: ${lambdaName} ===`);

  prepareLambdaDir(lambdaPath, lambdaName);

  runCommand('npm', ['ci', '--no-audit', '--no-fund'], { cwd: lambdaPath, env: process.env });
  runCommand('npm', ['run', 'build'], { cwd: lambdaPath, env: process.env });

  const zipPath = zipLambda(lambdaPath, lambdaName);
  console.log(`Created zip at ${zipPath}`);

  if (bucket) {
    uploadZip(zipPath, lambdaName);
    if (!keepLocalZips && existsSync(zipPath)) {
      rmSync(zipPath, { force: true });
    }
  }
}

function main() {
  assert(existsSync(lambdasDir), `Lambdas directory not found: ${lambdasDir}`);

  const entries = readdirSync(lambdasDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());

  if (entries.length === 0) {
    console.log('No Lambda directories found to package.');
    return;
  }

  for (const entry of entries) {
    buildLambda(entry);
  }
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
