# Service Compatibility Matrix

This matrix documents the handwritten, parity-tested service adapters in `src/services/index.js`.
It supplements the dynamic surface loaded from AWS Calculator's published manifest; it is not the
complete discovery catalog exposed by `list_service_catalog`.

Consumers should treat the per-region capability matrix as the source of truth. A shipped service may be `exact`, `modeled`, or `unavailable` by region over time. Bedrock is exact only where its current nested calculator payload has been parity-verified.

## Legend

- `exact`: calculator serialization, save, and validation are supported in that roadmap region
- `modeled`: available for planning and pricing, but not for official calculator-link creation
- `unavailable`: not supported in that roadmap region

## Summary

- Active live Calculator definitions: 430
- Generic definition-compiler coverage: 426 published entries
- Specialized active definitions: 3, all adapter-backed (EC2, EBS, Windows Workloads)
- Handwritten service adapters listed below: 36
- Implemented handwritten adapters: 36
- Modeled only: 0
- Unavailable in any roadmap region: 0

## Matrix

| Service ID | Name | Category | Status | Calculator Codes | us-east-1 | ca-central-1 | sa-east-1 | eu-west-1 | ap-southeast-2 | ap-northeast-2 | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `amazon-athena` | Amazon Athena | analytics | implemented | `amazonAthena` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-opensearch` | Amazon OpenSearch Service | analytics | implemented | `amazonElasticsearchService` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-redshift` | Amazon Redshift Serverless | analytics | implemented | `amazonRedshift` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-ec2` | Amazon EC2 | compute | implemented | `ec2Enhancement` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-ecs-ec2` | Amazon ECS on EC2 | compute | implemented | `ec2Enhancement` | exact | exact | exact | exact | exact | exact | Serialized as EC2-backed ECS container hosts and parity-validated as part of the exact surface. |
| `amazon-ecs-fargate` | Amazon ECS on Fargate | compute | implemented | `awsFargate` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-eks` | Amazon EKS | compute | implemented | `awsEks` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-lambda` | AWS Lambda | compute | implemented | `aWSLambda` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-aurora-mysql` | Amazon Aurora MySQL | database | implemented | `amazonAuroraMySQLCompatible` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-aurora-postgresql` | Amazon Aurora PostgreSQL | database | implemented | `amazonRDSAuroraPostgreSQLCompatibleDB` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-dynamodb` | Amazon DynamoDB | database | implemented | `dynamoDbOnDemand` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-elasticache-redis` | Amazon ElastiCache for Redis | database | implemented | `amazonElastiCache` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-rds-mysql` | Amazon RDS for MySQL | database | implemented | `amazonRDSMySQLDB` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-rds-postgresql` | Amazon RDS for PostgreSQL | database | implemented | `amazonRDSPostgreSQLDB` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-rds-sqlserver` | Amazon RDS for SQL Server | database | implemented | `amazonRDSForSQLServer` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-cloudfront` | Amazon CloudFront | edge | implemented | `amazonCloudFront` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-route53` | Amazon Route 53 | edge | implemented | `amazonRoute53` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-api-gateway-http` | Amazon API Gateway | integration | implemented | `amazonApiGateway` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-kinesis-firehose` | Amazon Data Firehose | integration | implemented | `amazonKinesisFirehose` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-eventbridge` | Amazon EventBridge | integration | implemented | `amazonEventBridge` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-sns` | Amazon SNS | integration | implemented | `standardTopics` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-sqs` | Amazon SQS | integration | implemented | `amazonSimpleQueueService` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `aws-glue-crawlers` | AWS Glue Crawlers | integration | implemented | `awsGlueCrawlers` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `aws-glue-etl` | AWS Glue ETL Jobs | integration | implemented | `awsEtlJobsAndDevelopmentEndpoints` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `aws-glue-data-catalog` | AWS Glue Data Catalog | metadata | implemented | `awsGlueDataCatalogStorageRequests` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-bedrock` | Amazon Bedrock | machine-learning | implemented | `amazonBedrock` | exact | modeled | modeled | modeled | modeled | modeled | Amazon Nova Lite Geo Cross Region On-Demand Standard is pinned to the current nested calculator schema; only us-east-1 has exact save/fetch parity coverage. |
| `amazon-vpc-nat` | Amazon VPC / NAT Gateway | networking | implemented | `amazonVirtualPrivateCloud` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `application-load-balancer` | Application Load Balancer | networking | implemented | `amazonELB` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `network-load-balancer` | Network Load Balancer | networking | implemented | `networkLoadBalancer` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-vpc-endpoints` | VPC Endpoints / PrivateLink | networking | implemented | `awsPrivateLinkVpc` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-cloudwatch` | Amazon CloudWatch | operations | implemented | `amazonCloudWatch` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `aws-waf-v2` | AWS WAF | security | implemented | `awsWebApplicationFirewall` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-ebs` | Amazon EBS | storage | implemented | `amazonElasticBlockStore` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-efs` | Amazon EFS | storage | implemented | `amazonEFS` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-fsx-windows` | Amazon FSx for Windows File Server | storage | implemented | `amazonFSx` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
| `amazon-s3` | Amazon S3 | storage | implemented | `amazonS3` | exact | exact | exact | exact | exact | exact | Service is calculator-save capable and parity-verified across the roadmap regions. |
