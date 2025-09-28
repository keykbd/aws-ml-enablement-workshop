# Implementation Plan: Infrastructure Unification for MLEW Tracker

## Direction
- Keep `MLEWTrackerDeploymentStack.yaml` as the single one-click entry point while standardising the provisioning it triggers to CloudFormation only.
- Preserve all product deliverables: the Lambda/API/DynamoDB backend, the CloudFront-hosted dashboard (`packages/dashboard`), and the CDN-distributed SDK (`packages/tracker-sdk`).

## Remediation Steps
1. **Restructure Lambda Sources**
   - Relocate `packages/cdk/lambda/{event-ingestion,query,stream-aggregation}` into a dedicated workspace namespace such as `packages/lambdas/<function>`.
   - Register the new workspaces in the root `package.json` and keep their existing TypeScript build/zip scripts so artefacts can be produced without CDK coupling.

2. **Retire the CDK Wrapper**
   - Remove `packages/cdk` (bin, config, scripts) and drop the related npm scripts from `package.json` and `package-lock.json` to eliminate the second deployment path.

3. **Streamline the CodeBuild Pipeline**
   - Replace the manual loop in `MLEWTrackerDeploymentStack.yaml` (lines ~200-320) with workspace-aware commands: a root `npm ci`, a new `npm run package:lambdas`, and the existing dashboard/SDK builds.
   - After stack deployment, upload both `packages/dashboard/dist/` and `packages/tracker-sdk/dist/` to their respective S3 buckets and invalidate the matching CloudFront distributions.

4. **Enhance the Workload Template**
   - Add outputs for the SDK bucket and distribution, and grant CloudFront access to `SDKBucket` (e.g., bucket policy or Origin Access Control) so the SDK CDN works.
   - Update Lambda runtimes from `nodejs18.x` to `nodejs20.x` to align with the build environment.

5. **Documentation Update**
   - Revise `yourwork/tracker/README.md` to describe the single CloudFormation-driven deployment path and clarify where the dashboard and SDK artefacts are published.

## Validation
- Run `npm install`, `npm run package:lambdas`, `npm run build --workspace=packages/dashboard`, and `npm run build --workspace=packages/tracker-sdk` locally to confirm artefact generation.
- Execute `npm test --workspaces` (or add smoke tests where missing) to ensure Lambda and SDK behaviour is intact post-move.
- Perform `aws cloudformation deploy --template-file MLEWTrackerStack.yaml --no-execute-changeset` to validate the template syntax and new outputs before full deployment.
