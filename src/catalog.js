import {
  TARGET_REGIONS,
  capabilityForRegion,
  getServiceDefinition,
  listServiceDefinitions,
} from "./services/index.js";

export const DEFAULT_REGION = "us-east-1";
export const DEFAULT_BUDGET_TOLERANCE_PCT = 0.1;
export const DEFAULT_ENVIRONMENT_SPLIT = {
  dev: 0.2,
  staging: 0.3,
  prod: 0.5,
};

export const DESIGN_REGIONS = [...TARGET_REGIONS];
export const EXACT_PRICING_REGIONS = [DEFAULT_REGION];

const TEMPLATE_METADATA = {
  "eks-rds-standard": {
    id: "eks-rds-standard",
    blueprintId: "container-platform",
    title: "EKS + RDS + Supportive Baseline",
    description:
      "Container-platform baseline for funding reviews. Models dev, staging, and prod EKS control planes, Linux worker nodes, PostgreSQL databases, and shared NAT/VPC support.",
    requiredServiceCodes: [
      "awsEks",
      "ec2Enhancement",
      "amazonRDSPostgreSQLDB",
      "amazonVirtualPrivateCloud",
    ],
    supportiveServiceCodes: ["amazonVirtualPrivateCloud"],
    supportiveInfra: ["VPC", "NAT Gateway"],
    primaryMinRatio: 0.8,
    supportiveMaxRatio: 0.2,
    computeOs: "linux",
    includeEks: true,
    supportiveTargetRatio: 0.03,
    minimumSupportiveUsd: 150,
    maximumSupportiveUsd: 500,
    workloadSignals: ["eks", "kubernetes", "argocd", "containers", "ecs"],
  },
  "linux-heavy": {
    id: "linux-heavy",
    blueprintId: "linux-web-stack",
    title: "Linux Heavy Baseline",
    description:
      "Linux-first fleet baseline for funding reviews. Models EC2 Linux as the primary spend driver, plus PostgreSQL and shared NAT/VPC support.",
    requiredServiceCodes: [
      "ec2Enhancement",
      "amazonRDSPostgreSQLDB",
      "amazonVirtualPrivateCloud",
    ],
    supportiveServiceCodes: ["amazonVirtualPrivateCloud"],
    supportiveInfra: ["VPC", "NAT Gateway"],
    primaryMinRatio: 0.8,
    supportiveMaxRatio: 0.2,
    computeOs: "linux",
    includeEks: false,
    supportiveTargetRatio: 0.03,
    minimumSupportiveUsd: 150,
    maximumSupportiveUsd: 450,
    workloadSignals: ["linux", "ec2", "vm", "fleet"],
  },
  "windows-heavy": {
    id: "windows-heavy",
    blueprintId: "windows-app-stack",
    title: "Windows Heavy Baseline",
    description:
      "Windows-first fleet baseline for funding reviews. Models EC2 Windows as the primary spend driver, plus PostgreSQL and shared NAT/VPC support.",
    requiredServiceCodes: [
      "ec2Enhancement",
      "amazonRDSPostgreSQLDB",
      "amazonVirtualPrivateCloud",
    ],
    supportiveServiceCodes: ["amazonVirtualPrivateCloud"],
    supportiveInfra: ["VPC", "NAT Gateway"],
    primaryMinRatio: 0.8,
    supportiveMaxRatio: 0.2,
    computeOs: "windows",
    includeEks: false,
    supportiveTargetRatio: 0.03,
    minimumSupportiveUsd: 150,
    maximumSupportiveUsd: 450,
    workloadSignals: ["windows", "active directory", "microsoft"],
  },
  "edge-api-serverless-standard": {
    id: "edge-api-serverless-standard",
    blueprintId: "edge-api-platform",
    title: "Edge API Serverless",
    description:
      "Serverless edge/API baseline with CloudFront, API Gateway, Lambda, DynamoDB, and lightweight edge/shared services.",
    requiredServiceCodes: [
      "amazonCloudFront",
      "amazonApiGateway",
      "amazonLambda",
      "amazonDynamoDB",
    ],
    supportiveServiceCodes: ["amazonRoute53", "amazonCloudWatch", "awsWAFv2"],
    supportiveInfra: ["Route 53", "CloudWatch", "AWS WAF"],
    primaryMinRatio: 0.75,
    supportiveMaxRatio: 0.25,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.08,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1200,
    workloadSignals: ["edge", "api", "serverless", "lambda", "cloudfront", "dynamodb"],
    coreStrategy: "weighted-services",
    coreBudgetWeights: {
      "amazon-cloudfront": 0.24,
      "amazon-api-gateway-http": 0.18,
      "amazon-lambda": 0.32,
      "amazon-dynamodb": 0.26,
    },
  },
  "edge-origin-platform-standard": {
    id: "edge-origin-platform-standard",
    blueprintId: "edge-api-platform",
    title: "Edge Origin Platform",
    description:
      "CloudFront-to-origin baseline with ALB origins, optional WAF, and edge/shared services.",
    requiredServiceCodes: ["amazonCloudFront", "amazonELB"],
    supportiveServiceCodes: ["amazonRoute53", "amazonCloudWatch", "awsWAFv2"],
    supportiveInfra: ["Route 53", "CloudWatch", "AWS WAF"],
    primaryMinRatio: 0.7,
    supportiveMaxRatio: 0.3,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.08,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1400,
    workloadSignals: ["edge", "cloudfront", "origin", "alb"],
    coreStrategy: "weighted-services",
    coreBudgetWeights: {
      "amazon-cloudfront": 0.52,
      "application-load-balancer": 0.48,
    },
  },
  "private-api-front-door-standard": {
    id: "private-api-front-door-standard",
    blueprintId: "edge-api-platform",
    title: "Private API Front Door",
    description:
      "Private API ingress baseline with API Gateway, NLB, and VPC endpoints for regulated/private connectivity.",
    requiredServiceCodes: ["amazonApiGateway", "amazonNLB", "awsPrivateLinkVpc"],
    supportiveServiceCodes: ["amazonCloudWatch"],
    supportiveInfra: ["CloudWatch"],
    primaryMinRatio: 0.82,
    supportiveMaxRatio: 0.18,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.03,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 700,
    workloadSignals: ["private", "privatelink", "api", "private api"],
    coreStrategy: "weighted-services",
    coreBudgetWeights: {
      "amazon-api-gateway-http": 0.28,
      "network-load-balancer": 0.34,
      "amazon-vpc-endpoints": 0.38,
    },
  },
  "event-driven-standard": {
    id: "event-driven-standard",
    blueprintId: "event-driven-platform",
    title: "Event-Driven Platform",
    description:
      "Async/event-native baseline with Lambda, queueing, routing, and messaging services as the primary architecture.",
    requiredServiceCodes: ["amazonLambda", "amazonSQS"],
    supportiveServiceCodes: ["amazonCloudWatch"],
    supportiveInfra: ["CloudWatch"],
    primaryMinRatio: 0.72,
    supportiveMaxRatio: 0.28,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.04,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 900,
    workloadSignals: ["event", "async", "queue", "lambda", "sqs", "sns", "eventbridge"],
    coreStrategy: "weighted-services",
    coreBudgetWeights: {
      "amazon-lambda": 0.4,
      "amazon-sqs": 0.25,
      "amazon-sns": 0.2,
      "amazon-eventbridge": 0.15,
    },
  },
  "modernization-fargate-standard": {
    id: "modernization-fargate-standard",
    blueprintId: "modernization-platform",
    title: "Modernization Fargate Target State",
    description:
      "Fargate-led modernization baseline with managed networking and storage add-ons sized around the target state.",
    requiredServiceCodes: ["awsFargate"],
    supportiveServiceCodes: ["amazonRoute53", "amazonCloudWatch", "amazonELB"],
    supportiveInfra: ["ALB", "Route 53", "CloudWatch"],
    primaryMinRatio: 0.68,
    supportiveMaxRatio: 0.32,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.07,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 2000,
    workloadSignals: ["modernization", "migration", "fargate", "ecs"],
    coreStrategy: "weighted-services",
    coreBudgetWeights: {
      "amazon-ecs-fargate": 0.7,
      "amazon-rds-postgresql": 0.3,
    },
  },
  "windows-sqlserver-standard": {
    id: "windows-sqlserver-standard",
    blueprintId: "windows-app-stack",
    title: "Windows SQL Server Application",
    description:
      "Windows application baseline with EC2 Windows, SQL Server, and optional file-share/security add-ons.",
    requiredServiceCodes: ["ec2Enhancement", "amazonRDSForSQLServer"],
    supportiveServiceCodes: ["amazonELB", "amazonRoute53", "amazonCloudWatch", "awsWAFv2"],
    supportiveInfra: ["ALB", "Route 53", "CloudWatch", "AWS WAF"],
    primaryMinRatio: 0.74,
    supportiveMaxRatio: 0.26,
    computeOs: "windows",
    includeEks: false,
    supportiveTargetRatio: 0.05,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1200,
    expectedEnvironments: ["shared"],
    workloadSignals: ["windows", "sql server", "iis", ".net", "fsx"],
    coreStrategy: "weighted-services",
    coreBudgetWeights: {
      "amazon-ec2": 0.58,
      "amazon-rds-sqlserver": 0.42,
    },
  },
  "windows-files-standard": {
    id: "windows-files-standard",
    blueprintId: "windows-app-stack",
    title: "Windows File-Centric Application",
    description:
      "Windows application baseline centered on EC2 and FSx for Windows File Server, with optional S3 and ingress add-ons.",
    requiredServiceCodes: ["ec2Enhancement", "amazonFSxWindowsFileServer"],
    supportiveServiceCodes: ["amazonCloudWatch", "amazonELB", "amazonRoute53"],
    supportiveInfra: ["CloudWatch", "ALB", "Route 53"],
    primaryMinRatio: 0.72,
    supportiveMaxRatio: 0.28,
    computeOs: "windows",
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.05,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1200,
    workloadSignals: ["windows", "fsx", "smb", "file share"],
    coreStrategy: "weighted-services",
    coreBudgetWeights: {
      "amazon-ec2": 0.74,
      "amazon-fsx-windows": 0.26,
    },
  },
  "container-api-front-door-standard": {
    id: "container-api-front-door-standard",
    blueprintId: "container-platform",
    title: "Container API Front Door",
    description:
      "Container application platform with EKS, managed API ingress, relational data, and standard observability/edge add-ons.",
    requiredServiceCodes: [
      "awsEks",
      "ec2Enhancement",
      "amazonRDSPostgreSQLDB",
      "amazonApiGateway",
    ],
    supportiveServiceCodes: ["amazonCloudWatch", "amazonELB", "amazonRoute53"],
    supportiveInfra: ["CloudWatch", "ALB", "Route 53"],
    primaryMinRatio: 0.76,
    supportiveMaxRatio: 0.24,
    computeOs: "linux",
    includeEks: true,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.05,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1200,
    workloadSignals: ["eks", "kubernetes", "api gateway", "postgres"],
  },
  "container-private-service-standard": {
    id: "container-private-service-standard",
    blueprintId: "container-platform",
    title: "Container Private Service",
    description:
      "Private container service baseline with EKS workers, PostgreSQL, NLB, and PrivateLink endpoints.",
    requiredServiceCodes: [
      "awsEks",
      "ec2Enhancement",
      "amazonRDSPostgreSQLDB",
      "amazonNLB",
      "awsPrivateLinkVpc",
    ],
    supportiveServiceCodes: ["amazonCloudWatch"],
    supportiveInfra: ["CloudWatch"],
    primaryMinRatio: 0.78,
    supportiveMaxRatio: 0.22,
    computeOs: "linux",
    includeEks: true,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.03,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 800,
    workloadSignals: ["eks", "kubernetes", "private", "privatelink", "nlb"],
    coreStrategy: "weighted-services",
    coreBudgetWeights: {
      "amazon-eks": 0.14,
      "amazon-ec2": 0.22,
      "amazon-rds-postgresql": 0.18,
      "network-load-balancer": 0.22,
      "amazon-vpc-endpoints": 0.24,
    },
  },
  "container-search-content-standard": {
    id: "container-search-content-standard",
    blueprintId: "container-platform",
    title: "Container Search and Content Platform",
    description:
      "EKS application baseline with OpenSearch-backed search and S3 asset storage.",
    requiredServiceCodes: [
      "awsEks",
      "ec2Enhancement",
      "amazonElasticsearchService",
      "amazonS3",
    ],
    supportiveServiceCodes: ["amazonCloudWatch", "amazonELB", "amazonRoute53"],
    supportiveInfra: ["CloudWatch", "ALB", "Route 53"],
    primaryMinRatio: 0.76,
    supportiveMaxRatio: 0.24,
    computeOs: "linux",
    includeEks: true,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.05,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1200,
    workloadSignals: ["eks", "kubernetes", "opensearch", "search", "s3"],
  },
  "linux-web-cdn-standard": {
    id: "linux-web-cdn-standard",
    blueprintId: "linux-web-stack",
    title: "Linux Web with CDN",
    description:
      "Linux EC2 web stack with PostgreSQL, CloudFront delivery, and standard web ingress add-ons.",
    requiredServiceCodes: [
      "ec2Enhancement",
      "amazonRDSPostgreSQLDB",
      "amazonCloudFront",
    ],
    supportiveServiceCodes: ["amazonELB", "amazonRoute53", "amazonCloudWatch"],
    supportiveInfra: ["ALB", "Route 53", "CloudWatch"],
    primaryMinRatio: 0.76,
    supportiveMaxRatio: 0.24,
    computeOs: "linux",
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.05,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1000,
    workloadSignals: ["linux", "cloudfront", "cdn", "web"],
  },
  "linux-web-private-standard": {
    id: "linux-web-private-standard",
    blueprintId: "linux-web-stack",
    title: "Linux Private Service",
    description:
      "Linux EC2 service baseline with PrivateLink endpoints and NLB-based private ingress.",
    requiredServiceCodes: ["ec2Enhancement", "amazonNLB", "awsPrivateLinkVpc"],
    supportiveServiceCodes: ["amazonCloudWatch", "amazonRoute53"],
    supportiveInfra: ["CloudWatch", "Route 53"],
    primaryMinRatio: 0.76,
    supportiveMaxRatio: 0.24,
    computeOs: "linux",
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.04,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 900,
    workloadSignals: ["linux", "privatelink", "private", "nlb"],
    coreStrategy: "weighted-services",
    coreBudgetWeights: {
      "amazon-ec2": 0.46,
      "network-load-balancer": 0.28,
      "amazon-vpc-endpoints": 0.26,
    },
  },
  "lake-foundation-standard": {
    id: "lake-foundation-standard",
    blueprintId: "lake-foundation",
    title: "Lake Foundation",
    description:
      "Foundational data lake baseline with S3, Athena, Glue ETL, Glue Catalog, and Crawlers for shared data domains.",
    requiredServiceCodes: [
      "amazonS3",
      "amazonAthena",
      "awsEtlJobsAndDevelopmentEndpoints",
      "awsGlueDataCatalogStorageRequests",
      "awsGlueCrawlers",
    ],
    supportiveServiceCodes: ["amazonCloudWatch", "awsPrivateLinkVpc"],
    supportiveInfra: ["CloudWatch", "PrivateLink"],
    primaryMinRatio: 0.85,
    supportiveMaxRatio: 0.15,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.03,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1500,
    workloadSignals: ["data lake", "athena", "glue", "catalog", "crawler"],
    coreStrategy: "shared-services",
  },
  "lakehouse-platform-standard": {
    id: "lakehouse-platform-standard",
    blueprintId: "lakehouse-platform",
    title: "Lakehouse Platform",
    description:
      "Lakehouse baseline with S3 storage, Athena query, Redshift serving, and Glue-driven metadata and ETL.",
    requiredServiceCodes: [
      "amazonS3",
      "amazonAthena",
      "amazonRedshift",
      "awsEtlJobsAndDevelopmentEndpoints",
      "awsGlueDataCatalogStorageRequests",
    ],
    supportiveServiceCodes: ["amazonCloudWatch", "awsPrivateLinkVpc"],
    supportiveInfra: ["CloudWatch", "PrivateLink"],
    primaryMinRatio: 0.88,
    supportiveMaxRatio: 0.12,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.03,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1800,
    workloadSignals: ["lakehouse", "data lake", "redshift", "athena", "glue"],
    coreStrategy: "shared-services",
  },
  "streaming-data-platform-standard": {
    id: "streaming-data-platform-standard",
    blueprintId: "streaming-data-platform",
    title: "Streaming Data Platform",
    description:
      "Streaming analytics baseline with Firehose ingestion, S3 landing, Athena query, and Glue metadata/ETL.",
    requiredServiceCodes: [
      "amazonS3",
      "amazonKinesisFirehose",
      "awsEtlJobsAndDevelopmentEndpoints",
      "awsGlueDataCatalogStorageRequests",
      "amazonAthena",
    ],
    supportiveServiceCodes: ["amazonCloudWatch", "awsPrivateLinkVpc"],
    supportiveInfra: ["CloudWatch", "PrivateLink"],
    primaryMinRatio: 0.86,
    supportiveMaxRatio: 0.14,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.04,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1800,
    workloadSignals: ["stream", "streaming", "firehose", "real-time", "events"],
    coreStrategy: "shared-services",
  },
  "warehouse-centric-analytics-standard": {
    id: "warehouse-centric-analytics-standard",
    blueprintId: "warehouse-centric-analytics",
    title: "Warehouse-Centric Analytics",
    description:
      "Warehouse-first analytics baseline with Redshift serving, S3 landing, and Glue metadata/ETL.",
    requiredServiceCodes: [
      "amazonS3",
      "amazonRedshift",
      "awsEtlJobsAndDevelopmentEndpoints",
      "awsGlueDataCatalogStorageRequests",
    ],
    supportiveServiceCodes: ["amazonCloudWatch", "awsPrivateLinkVpc"],
    supportiveInfra: ["CloudWatch", "PrivateLink"],
    primaryMinRatio: 0.88,
    supportiveMaxRatio: 0.12,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.03,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1800,
    workloadSignals: ["warehouse", "redshift", "bi", "analytics"],
    coreStrategy: "shared-services",
  },
  "enterprise-data-lake-standard": {
    id: "enterprise-data-lake-standard",
    blueprintId: "enterprise-data-lake",
    title: "Enterprise Data Lake",
    description:
      "Enterprise data lake baseline for funding reviews. Models shared object storage, analytics, ETL, catalog, and crawler services instead of padding spend with generic compute.",
    requiredServiceCodes: [
      "amazonS3",
      "amazonAthena",
      "amazonRedshift",
      "awsEtlJobsAndDevelopmentEndpoints",
      "awsGlueDataCatalogStorageRequests",
    ],
    supportiveServiceCodes: ["amazonCloudWatch", "awsPrivateLinkVpc"],
    supportiveInfra: ["CloudWatch", "PrivateLink"],
    primaryMinRatio: 0.85,
    supportiveMaxRatio: 0.15,
    computeOs: null,
    includeEks: false,
    expectedEnvironments: ["shared"],
    supportiveTargetRatio: 0.03,
    minimumSupportiveUsd: 0,
    maximumSupportiveUsd: 1500,
    workloadSignals: [
      "enterprise data lake",
      "data lake",
      "lakehouse",
      "athena",
      "redshift",
      "glue",
    ],
    coreStrategy: "shared-services",
    coreBudgetWeights: {
      "amazon-s3": 0.4,
      "amazon-athena": 0.08,
      "amazon-redshift": 0.35,
      "aws-glue-etl": 0.15,
      "aws-glue-data-catalog": 0.02,
    },
  },
  "data-platform-standard": {
    id: "data-platform-standard",
    blueprintId: "data-platform-lite",
    title: "Data Platform Baseline",
    description:
      "Data-oriented baseline for funding reviews. Models shared storage, Aurora PostgreSQL, modest Linux orchestration compute, and shared VPC/NAT support.",
    requiredServiceCodes: [
      "ec2Enhancement",
      "amazonS3",
      "amazonRDSAuroraPostgreSQLCompatibleDB",
      "amazonVirtualPrivateCloud",
    ],
    supportiveServiceCodes: ["amazonVirtualPrivateCloud"],
    supportiveInfra: ["VPC", "NAT Gateway"],
    primaryMinRatio: 0.65,
    supportiveMaxRatio: 0.35,
    computeOs: "linux",
    includeEks: false,
    supportiveTargetRatio: 0.06,
    minimumSupportiveUsd: 200,
    maximumSupportiveUsd: 900,
    workloadSignals: ["data lake", "analytics", "warehouse", "etl", "stream"],
    coreStrategy: "data-services",
    coreBudgetWeights: {
      "amazon-s3": 0.42,
      "amazon-aurora-postgresql": 0.34,
      "amazon-ec2": 0.24,
    },
  },
  "enterprise-data-standard": {
    id: "enterprise-data-standard",
    blueprintId: "enterprise-data-platform",
    title: "Enterprise Data Platform Baseline",
    description:
      "Enterprise data baseline for funding reviews. Models shared object storage, Aurora PostgreSQL, OpenSearch, private networking, modest Linux orchestration compute, and shared VPC/NAT support.",
    requiredServiceCodes: [
      "ec2Enhancement",
      "amazonS3",
      "amazonRDSAuroraPostgreSQLCompatibleDB",
      "amazonElasticsearchService",
      "awsPrivateLinkVpc",
      "amazonVirtualPrivateCloud",
    ],
    supportiveServiceCodes: ["amazonVirtualPrivateCloud", "awsPrivateLinkVpc"],
    supportiveInfra: ["VPC", "NAT Gateway", "PrivateLink"],
    primaryMinRatio: 0.6,
    supportiveMaxRatio: 0.4,
    computeOs: "linux",
    includeEks: false,
    supportiveTargetRatio: 0.08,
    minimumSupportiveUsd: 300,
    maximumSupportiveUsd: 1800,
    workloadSignals: ["enterprise data lake", "data lake", "lakehouse", "analytics"],
    coreStrategy: "data-services",
    coreBudgetWeights: {
      "amazon-s3": 0.32,
      "amazon-aurora-postgresql": 0.26,
      "amazon-opensearch": 0.18,
      "amazon-vpc-endpoints": 0.08,
      "amazon-ec2": 0.16,
    },
  },
};

const BLUEPRINT_PACKS = {
  observability: {
    id: "observability",
    title: "Observability Pack",
    description: "CloudWatch-backed operational visibility and baseline monitoring.",
    defaultAddOnServiceIds: ["amazon-cloudwatch"],
    optionalServiceIds: [],
    addOnAllocations: {
      "amazon-cloudwatch": 0.015,
    },
  },
  edge: {
    id: "edge",
    title: "Edge Pack",
    description: "ALB/Route 53 edge routing with optional CloudFront and WAF controls.",
    defaultAddOnServiceIds: ["application-load-balancer", "amazon-route53"],
    optionalServiceIds: ["amazon-cloudfront", "aws-waf-v2", "network-load-balancer"],
    addOnAllocations: {
      "application-load-balancer": 0.04,
      "amazon-route53": 0.005,
      "amazon-cloudfront": 0.03,
      "aws-waf-v2": 0.015,
      "network-load-balancer": 0.03,
    },
  },
  "storage-data": {
    id: "storage-data",
    title: "Storage and Data Pack",
    description:
      "Baseline S3-backed storage with optional DynamoDB, Redis, OpenSearch, EFS, and EBS extensions.",
    defaultAddOnServiceIds: ["amazon-s3"],
    optionalServiceIds: [
      "amazon-dynamodb",
      "amazon-elasticache-redis",
      "amazon-opensearch",
      "amazon-efs",
      "amazon-ebs",
    ],
    addOnAllocations: {
      "amazon-s3": 0.02,
      "amazon-dynamodb": 0.04,
      "amazon-elasticache-redis": 0.04,
      "amazon-opensearch": 0.06,
      "amazon-efs": 0.03,
      "amazon-ebs": 0.02,
    },
  },
  eventing: {
    id: "eventing",
    title: "Eventing Pack",
    description: "EventBridge orchestration with queueing and fanout options.",
    defaultAddOnServiceIds: ["amazon-eventbridge"],
    optionalServiceIds: ["amazon-sqs", "amazon-sns"],
    addOnAllocations: {
      "amazon-eventbridge": 0.015,
      "amazon-sqs": 0.02,
      "amazon-sns": 0.02,
    },
  },
  windows: {
    id: "windows",
    title: "Windows Pack",
    description: "Windows-specific shared services and Microsoft-aligned data options.",
    defaultAddOnServiceIds: [],
    optionalServiceIds: ["amazon-fsx-windows", "amazon-rds-sqlserver"],
    addOnAllocations: {
      "amazon-fsx-windows": 0.04,
      "amazon-rds-sqlserver": 0.08,
    },
  },
  "private-networking": {
    id: "private-networking",
    title: "Private Networking Pack",
    description: "PrivateLink-style private connectivity patterns for regulated architectures.",
    defaultAddOnServiceIds: [],
    optionalServiceIds: ["amazon-vpc-endpoints"],
    addOnAllocations: {
      "amazon-vpc-endpoints": 0.025,
    },
  },
};

function dedupe(values) {
  return [...new Set(values)];
}

function composeBlueprint({
  id,
  title,
  description,
  templateId,
  defaultOperatingSystem,
  keywords,
  requiredServiceIds,
  packIds = [],
  defaultAddOnServiceIds = [],
  optionalServiceIds = [],
  addOnAllocations = {},
  requiredServiceFamilies = [],
  architectureFamily = "application-platform",
  architectureSubtype = id,
  candidateEligible = true,
  visible = true,
  environmentModel = "three-environment",
  requiredCapabilities = [],
  budgetGuidance = {
    minimumMonthlyUsd: 3_000,
    preferredMinMonthlyUsd: 5_000,
    preferredMaxMonthlyUsd: 25_000,
  },
  signalProfile = {},
  coreBudgetWeights = null,
  primaryServiceIds = [],
  forbiddenServiceIds = [],
  serviceRoles = {},
}) {
  const packs = packIds.map((packId) => {
    const pack = BLUEPRINT_PACKS[packId];

    if (!pack) {
      throw new Error(`Unknown blueprint pack '${packId}'.`);
    }

    return pack;
  });

  return {
    id,
    title,
    description,
    templateId,
    architectureFamily,
    architectureSubtype,
    candidateEligible,
    visible,
    environmentModel,
    defaultOperatingSystem,
    keywords,
    requiredCapabilities,
    budgetGuidance,
    signalProfile: {
      boost: [...(signalProfile.boost ?? [])],
      penalize: [...(signalProfile.penalize ?? [])],
      requireAny: [...(signalProfile.requireAny ?? [])],
    },
    packIds,
    packs: packs.map(({ id: packId, title: packTitle, description: packDescription }) => ({
      id: packId,
      title: packTitle,
      description: packDescription,
    })),
    requiredServiceFamilies,
    primaryServiceIds: dedupe(primaryServiceIds),
    forbiddenServiceIds: dedupe(forbiddenServiceIds),
    coreBudgetWeights: coreBudgetWeights ? { ...coreBudgetWeights } : null,
    serviceRoles: { ...serviceRoles },
    requiredServiceIds: dedupe(requiredServiceIds),
    defaultAddOnServiceIds: dedupe([
      ...packs.flatMap((pack) => pack.defaultAddOnServiceIds),
      ...defaultAddOnServiceIds,
    ]),
    optionalServiceIds: dedupe([
      ...packs.flatMap((pack) => pack.optionalServiceIds),
      ...optionalServiceIds,
    ]),
    addOnAllocations: {
      ...packs.reduce((all, pack) => ({ ...all, ...pack.addOnAllocations }), {}),
      ...addOnAllocations,
    },
  };
}

const BLUEPRINTS = {
  "container-platform": composeBlueprint({
    id: "container-platform",
    title: "Container Platform",
    description:
      "Three-environment container platform with EKS or Kubernetes-adjacent workloads, relational data, and shared networking.",
    templateId: "eks-rds-standard",
    architectureFamily: "application-platform",
    architectureSubtype: "container-platform",
    defaultOperatingSystem: "linux",
    keywords: ["eks", "kubernetes", "ecs", "argocd", "container", "containers"],
    requiredCapabilities: ["container orchestration", "relational data", "shared networking"],
    budgetGuidance: {
      minimumMonthlyUsd: 5_000,
      preferredMinMonthlyUsd: 7_000,
      preferredMaxMonthlyUsd: 25_000,
    },
    signalProfile: {
      boost: ["containers", "kubernetes", "gitops", "relational"],
      penalize: ["data-lake", "warehouse", "windows"],
      requireAny: ["containers", "kubernetes"],
    },
    packIds: ["edge", "observability", "storage-data"],
    requiredServiceIds: [
      "amazon-eks",
      "amazon-ec2",
      "amazon-rds-postgresql",
      "amazon-vpc-nat",
    ],
    primaryServiceIds: ["amazon-eks", "amazon-ec2", "amazon-rds-postgresql"],
    optionalServiceIds: ["amazon-sqs", "amazon-sns"],
    addOnAllocations: {
      "amazon-sqs": 0.01,
      "amazon-sns": 0.01,
    },
    requiredServiceFamilies: ["compute", "database", "networking"],
    serviceRoles: {
      "amazon-eks": {
        role: "container-control-plane",
        rationale: "Provides the Kubernetes control plane for the application platform.",
      },
      "amazon-ec2": {
        role: "container-workers",
        rationale: "Runs the Kubernetes worker capacity for the application workloads.",
      },
      "amazon-rds-postgresql": {
        role: "transactional-database",
        rationale: "Stores relational application data for the platform workloads.",
      },
      "amazon-vpc-nat": {
        role: "egress-networking",
        rationale: "Provides shared VPC and NAT networking for platform egress.",
      },
    },
  }),
  "linux-web-stack": composeBlueprint({
    id: "linux-web-stack",
    title: "Linux Web Stack",
    description:
      "Three-environment Linux application stack with EC2, PostgreSQL, and shared networking plus web-edge services.",
    templateId: "linux-heavy",
    architectureFamily: "application-platform",
    architectureSubtype: "vm-web-platform",
    defaultOperatingSystem: "linux",
    keywords: ["linux", "web", "app", "fleet", "ec2"],
    requiredCapabilities: ["vm runtime", "relational data", "shared networking"],
    budgetGuidance: {
      minimumMonthlyUsd: 4_000,
      preferredMinMonthlyUsd: 5_000,
      preferredMaxMonthlyUsd: 20_000,
    },
    signalProfile: {
      boost: ["linux", "vm-runtime", "web"],
      penalize: ["windows", "data-lake", "warehouse"],
      requireAny: ["linux", "vm-runtime", "web"],
    },
    packIds: ["edge", "observability", "storage-data"],
    requiredServiceIds: [
      "amazon-ec2",
      "amazon-rds-postgresql",
      "amazon-vpc-nat",
    ],
    primaryServiceIds: ["amazon-ec2", "amazon-rds-postgresql"],
    optionalServiceIds: ["amazon-api-gateway-http"],
    addOnAllocations: {
      "application-load-balancer": 0.05,
      "amazon-s3": 0.025,
      "amazon-api-gateway-http": 0.02,
    },
    requiredServiceFamilies: ["compute", "database", "networking"],
    serviceRoles: {
      "amazon-ec2": {
        role: "application-runtime",
        rationale: "Runs the primary Linux web or application workload.",
      },
      "amazon-rds-postgresql": {
        role: "application-database",
        rationale: "Stores relational state for the Linux application stack.",
      },
      "amazon-vpc-nat": {
        role: "egress-networking",
        rationale: "Provides shared VPC and NAT networking for the stack.",
      },
    },
  }),
  "windows-app-stack": composeBlueprint({
    id: "windows-app-stack",
    title: "Windows Application Stack",
    description:
      "Three-environment Windows-heavy application stack with EC2, PostgreSQL baseline data, and shared networking.",
    templateId: "windows-heavy",
    architectureFamily: "application-platform",
    architectureSubtype: "windows-app-platform",
    defaultOperatingSystem: "windows",
    keywords: ["windows", "microsoft", "active directory", "iis"],
    requiredCapabilities: ["windows runtime", "relational data", "shared networking"],
    budgetGuidance: {
      minimumMonthlyUsd: 5_000,
      preferredMinMonthlyUsd: 6_000,
      preferredMaxMonthlyUsd: 25_000,
    },
    signalProfile: {
      boost: ["windows", "microsoft"],
      penalize: ["containers", "data-lake", "warehouse"],
      requireAny: ["windows", "microsoft"],
    },
    packIds: ["edge", "observability", "storage-data", "windows"],
    requiredServiceIds: [
      "amazon-ec2",
      "amazon-rds-postgresql",
      "amazon-vpc-nat",
    ],
    addOnAllocations: {
      "amazon-s3": 0.015,
      "application-load-balancer": 0.04,
    },
    requiredServiceFamilies: ["compute", "database", "networking"],
    primaryServiceIds: ["amazon-ec2", "amazon-rds-postgresql"],
    serviceRoles: {
      "amazon-ec2": {
        role: "windows-runtime",
        rationale: "Runs the primary Windows application workload.",
      },
      "amazon-rds-postgresql": {
        role: "application-database",
        rationale: "Provides the baseline relational database tier.",
      },
      "amazon-vpc-nat": {
        role: "egress-networking",
        rationale: "Provides shared VPC and NAT networking for the stack.",
      },
    },
  }),
  "edge-api-platform": composeBlueprint({
    id: "edge-api-platform",
    title: "Edge API Platform",
    description:
      "API-first platform with edge delivery, serverless components, managed data, and core VPC services.",
    templateId: "linux-heavy",
    architectureFamily: "edge-platform",
    architectureSubtype: "edge-api-platform",
    defaultOperatingSystem: "linux",
    keywords: ["api", "edge", "cloudfront", "lambda", "serverless"],
    requiredCapabilities: ["edge delivery", "api runtime", "managed data", "shared networking"],
    budgetGuidance: {
      minimumMonthlyUsd: 6_000,
      preferredMinMonthlyUsd: 8_000,
      preferredMaxMonthlyUsd: 25_000,
    },
    signalProfile: {
      boost: ["edge", "api", "serverless"],
      penalize: ["windows", "data-lake"],
      requireAny: ["edge", "api", "serverless"],
    },
    packIds: ["edge", "observability", "storage-data", "eventing"],
    requiredServiceIds: [
      "amazon-ec2",
      "amazon-vpc-nat",
      "amazon-cloudfront",
      "amazon-api-gateway-http",
      "amazon-lambda",
      "amazon-dynamodb",
    ],
    addOnAllocations: {
      "amazon-cloudfront": 0.05,
      "amazon-api-gateway-http": 0.04,
      "amazon-lambda": 0.08,
      "amazon-dynamodb": 0.08,
      "application-load-balancer": 0.03,
    },
    requiredServiceFamilies: ["compute", "edge", "database", "networking"],
    primaryServiceIds: [
      "amazon-cloudfront",
      "amazon-api-gateway-http",
      "amazon-lambda",
      "amazon-dynamodb",
    ],
    forbiddenServiceIds: ["amazon-redshift", "amazon-athena"],
    serviceRoles: {
      "amazon-cloudfront": {
        role: "edge-delivery",
        rationale: "Delivers the API/application experience at the edge.",
      },
      "amazon-api-gateway-http": {
        role: "api-front-door",
        rationale: "Publishes the managed API ingress for the platform.",
      },
      "amazon-lambda": {
        role: "api-runtime",
        rationale: "Runs serverless request and background logic for the API platform.",
      },
      "amazon-dynamodb": {
        role: "managed-state-store",
        rationale: "Provides low-latency managed persistence for the platform.",
      },
      "amazon-vpc-nat": {
        role: "shared-networking",
        rationale: "Provides shared VPC and NAT networking for supporting services.",
      },
    },
  }),
  "event-driven-platform": composeBlueprint({
    id: "event-driven-platform",
    title: "Event-Driven Platform",
    description:
      "Application stack with asynchronous messaging, Lambda workers, and managed data services.",
    templateId: "linux-heavy",
    architectureFamily: "integration-platform",
    architectureSubtype: "event-driven-platform",
    defaultOperatingSystem: "linux",
    keywords: ["event-driven", "sqs", "sns", "eventbridge", "queue", "async"],
    requiredCapabilities: ["event routing", "queueing", "worker runtime", "managed data"],
    budgetGuidance: {
      minimumMonthlyUsd: 6_000,
      preferredMinMonthlyUsd: 8_000,
      preferredMaxMonthlyUsd: 22_000,
    },
    signalProfile: {
      boost: ["eventing", "async", "queueing"],
      penalize: ["warehouse", "data-lake"],
      requireAny: ["eventing", "async", "queueing"],
    },
    packIds: ["observability", "storage-data", "eventing"],
    requiredServiceIds: [
      "amazon-ec2",
      "amazon-rds-postgresql",
      "amazon-vpc-nat",
      "amazon-lambda",
      "amazon-sqs",
      "amazon-sns",
    ],
    optionalServiceIds: ["amazon-api-gateway-http"],
    addOnAllocations: {
      "amazon-lambda": 0.06,
      "amazon-api-gateway-http": 0.02,
    },
    requiredServiceFamilies: ["compute", "database", "integration", "networking"],
    primaryServiceIds: ["amazon-lambda", "amazon-sqs", "amazon-sns", "amazon-eventbridge"],
    forbiddenServiceIds: ["amazon-redshift", "amazon-athena"],
    serviceRoles: {
      "amazon-lambda": {
        role: "event-workers",
        rationale: "Runs the event-processing worker logic.",
      },
      "amazon-sqs": {
        role: "queue-buffer",
        rationale: "Buffers asynchronous workloads and decouples producers from consumers.",
      },
      "amazon-sns": {
        role: "fanout-messaging",
        rationale: "Fans out notifications and async events to subscribers.",
      },
      "amazon-eventbridge": {
        role: "event-router",
        rationale: "Routes events between producers, consumers, and automation flows.",
      },
    },
  }),
  "data-platform-lite": composeBlueprint({
    id: "data-platform-lite",
    title: "Data Platform Lite",
    description:
      "Lightweight data-oriented platform with storage, operational analytics signals, and managed databases.",
    templateId: "data-platform-standard",
    architectureFamily: "data-platform",
    architectureSubtype: "legacy-data-platform-lite",
    candidateEligible: false,
    visible: false,
    defaultOperatingSystem: "linux",
    keywords: ["data platform", "analytics", "etl", "warehouse", "stream", "lakehouse"],
    packIds: ["observability", "storage-data", "eventing"],
    requiredServiceIds: [
      "amazon-ec2",
      "amazon-vpc-nat",
      "amazon-s3",
      "amazon-aurora-postgresql",
    ],
    defaultAddOnServiceIds: ["amazon-dynamodb", "amazon-sqs"],
    optionalServiceIds: [
      "amazon-opensearch",
      "amazon-aurora-mysql",
      "amazon-elasticache-redis",
    ],
    addOnAllocations: {
      "amazon-s3": 0.05,
      "amazon-cloudwatch": 0.02,
      "amazon-dynamodb": 0.04,
      "amazon-sqs": 0.015,
      "amazon-aurora-postgresql": 0.08,
      "amazon-aurora-mysql": 0.08,
    },
    requiredServiceFamilies: ["compute", "database", "storage", "networking"],
    primaryServiceIds: ["amazon-s3", "amazon-aurora-postgresql", "amazon-ec2"],
  }),
  "modernization-platform": composeBlueprint({
    id: "modernization-platform",
    title: "Modernization Platform",
    description:
      "Modernization-oriented application platform with ECS/Fargate, managed networking, and shared platform services.",
    templateId: "linux-heavy",
    architectureFamily: "application-platform",
    architectureSubtype: "modernization-platform",
    defaultOperatingSystem: "linux",
    keywords: ["modernization", "migration", "fargate", "ecs", "refactor"],
    requiredCapabilities: ["modernized runtime", "relational data", "migration-ready networking"],
    budgetGuidance: {
      minimumMonthlyUsd: 8_000,
      preferredMinMonthlyUsd: 12_000,
      preferredMaxMonthlyUsd: 30_000,
    },
    signalProfile: {
      boost: ["modernization", "migration", "containers"],
      penalize: ["warehouse", "data-lake"],
      requireAny: ["modernization", "migration"],
    },
    packIds: ["edge", "observability", "storage-data", "private-networking"],
    requiredServiceIds: [
      "amazon-ec2",
      "amazon-rds-postgresql",
      "amazon-vpc-nat",
      "amazon-ecs-fargate",
    ],
    optionalServiceIds: [
      "amazon-efs",
      "amazon-ebs",
      "amazon-vpc-endpoints",
      "amazon-elasticache-redis",
    ],
    addOnAllocations: {
      "amazon-ecs-fargate": 0.12,
      "amazon-efs": 0.03,
      "amazon-ebs": 0.02,
    },
    requiredServiceFamilies: ["compute", "database", "networking"],
    primaryServiceIds: ["amazon-ecs-fargate", "amazon-rds-postgresql", "amazon-ec2"],
    serviceRoles: {
      "amazon-ecs-fargate": {
        role: "modernized-application-runtime",
        rationale: "Hosts the containerized runtime for the modernization target state.",
      },
      "amazon-ec2": {
        role: "transition-runtime",
        rationale: "Carries remaining VM-based or supporting migration workloads.",
      },
      "amazon-rds-postgresql": {
        role: "application-database",
        rationale: "Provides the relational data layer during and after modernization.",
      },
      "amazon-vpc-nat": {
        role: "shared-networking",
        rationale: "Provides baseline VPC and NAT networking for the modernization platform.",
      },
    },
  }),
  "enterprise-data-platform": composeBlueprint({
    id: "enterprise-data-platform",
    title: "Enterprise Data Platform",
    description:
      "Enterprise-oriented data platform with Aurora-class databases, analytics services, and private networking options.",
    templateId: "enterprise-data-standard",
    architectureFamily: "data-platform",
    architectureSubtype: "legacy-enterprise-data-platform",
    candidateEligible: false,
    visible: false,
    defaultOperatingSystem: "linux",
    keywords: [
      "enterprise analytics",
      "enterprise data platform",
      "analytics platform",
      "aurora",
      "opensearch",
      "redis",
      "analytics",
    ],
    packIds: ["observability", "storage-data", "eventing", "private-networking"],
    requiredServiceIds: [
      "amazon-ec2",
      "amazon-vpc-nat",
      "amazon-s3",
      "amazon-aurora-postgresql",
      "amazon-opensearch",
      "amazon-vpc-endpoints",
    ],
    optionalServiceIds: [
      "amazon-aurora-mysql",
      "amazon-rds-mysql",
      "amazon-rds-sqlserver",
      "amazon-elasticache-redis",
      "amazon-efs",
    ],
    addOnAllocations: {
      "amazon-aurora-postgresql": 0.12,
      "amazon-aurora-mysql": 0.12,
      "amazon-rds-mysql": 0.08,
      "amazon-rds-sqlserver": 0.12,
      "amazon-elasticache-redis": 0.05,
      "amazon-opensearch": 0.08,
    },
    requiredServiceFamilies: ["compute", "database", "storage", "networking"],
    primaryServiceIds: [
      "amazon-s3",
      "amazon-aurora-postgresql",
      "amazon-opensearch",
      "amazon-vpc-endpoints",
    ],
  }),
  "enterprise-data-lake": composeBlueprint({
    id: "enterprise-data-lake",
    title: "Enterprise Data Lake",
    description:
      "Shared data lake architecture with S3, Athena, Redshift Serverless, and Glue-driven ingestion/catalog services.",
    templateId: "enterprise-data-lake-standard",
    architectureFamily: "data-platform",
    architectureSubtype: "legacy-enterprise-data-lake",
    candidateEligible: false,
    visible: false,
    defaultOperatingSystem: "linux",
    keywords: [
      "enterprise data lake",
      "data lake",
      "lakehouse",
      "athena",
      "redshift",
      "glue",
      "crawler",
      "catalog",
    ],
    packIds: ["observability", "private-networking"],
    requiredServiceIds: [
      "amazon-s3",
      "amazon-athena",
      "amazon-redshift",
      "aws-glue-etl",
      "aws-glue-data-catalog",
    ],
    optionalServiceIds: [
      "aws-glue-crawlers",
      "amazon-kinesis-firehose",
      "amazon-vpc-endpoints",
    ],
    addOnAllocations: {
      "amazon-cloudwatch": 0.015,
      "aws-glue-crawlers": 0.02,
      "amazon-kinesis-firehose": 0.08,
      "amazon-vpc-endpoints": 0.03,
    },
    requiredServiceFamilies: ["storage", "analytics", "integration"],
    primaryServiceIds: [
      "amazon-s3",
      "amazon-athena",
      "amazon-redshift",
      "aws-glue-etl",
      "aws-glue-data-catalog",
    ],
  }),
  "lake-foundation": composeBlueprint({
    id: "lake-foundation",
    title: "Lake Foundation",
    description:
      "Shared data lake foundation with object storage, metadata, crawlers, ETL, and query services.",
    templateId: "lake-foundation-standard",
    architectureFamily: "data-platform",
    architectureSubtype: "lake-foundation",
    environmentModel: "shared",
    defaultOperatingSystem: "linux",
    keywords: ["data lake", "lake foundation", "athena", "glue", "catalog", "crawler"],
    requiredCapabilities: ["object storage", "metadata catalog", "batch query", "data preparation"],
    budgetGuidance: {
      minimumMonthlyUsd: 8_000,
      preferredMinMonthlyUsd: 12_000,
      preferredMaxMonthlyUsd: 60_000,
    },
    signalProfile: {
      boost: ["data-lake", "analytics", "catalog"],
      penalize: ["warehouse", "windows", "containers"],
      requireAny: ["data-lake", "analytics"],
    },
    packIds: ["observability", "private-networking"],
    requiredServiceIds: [
      "amazon-s3",
      "amazon-athena",
      "aws-glue-etl",
      "aws-glue-data-catalog",
      "aws-glue-crawlers",
    ],
    optionalServiceIds: ["amazon-kinesis-firehose", "amazon-vpc-endpoints"],
    addOnAllocations: {
      "amazon-cloudwatch": 0.015,
      "amazon-kinesis-firehose": 0.06,
      "amazon-vpc-endpoints": 0.03,
    },
    coreBudgetWeights: {
      "amazon-s3": 0.54,
      "amazon-athena": 0.16,
      "aws-glue-etl": 0.16,
      "aws-glue-data-catalog": 0.08,
      "aws-glue-crawlers": 0.06,
    },
    requiredServiceFamilies: ["storage", "analytics", "integration", "metadata"],
    primaryServiceIds: [
      "amazon-s3",
      "amazon-athena",
      "aws-glue-etl",
      "aws-glue-data-catalog",
      "aws-glue-crawlers",
    ],
    forbiddenServiceIds: ["amazon-ec2", "amazon-rds-postgresql", "amazon-opensearch"],
    serviceRoles: {
      "amazon-s3": {
        role: "lake-storage",
        rationale: "Stores raw, staged, and curated data in the lake.",
      },
      "amazon-athena": {
        role: "lake-query",
        rationale: "Provides ad hoc SQL access over lake data.",
      },
      "aws-glue-etl": {
        role: "data-transforms",
        rationale: "Runs ETL jobs to prepare and curate lake datasets.",
      },
      "aws-glue-data-catalog": {
        role: "metadata-catalog",
        rationale: "Stores the metadata catalog for lake tables and schemas.",
      },
      "aws-glue-crawlers": {
        role: "schema-discovery",
        rationale: "Discovers and updates metadata for newly landed data.",
      },
    },
  }),
  "lakehouse-platform": composeBlueprint({
    id: "lakehouse-platform",
    title: "Lakehouse Platform",
    description:
      "Shared lakehouse with object storage, Glue metadata/ETL, Athena exploration, and Redshift serving.",
    templateId: "lakehouse-platform-standard",
    architectureFamily: "data-platform",
    architectureSubtype: "lakehouse-platform",
    environmentModel: "shared",
    defaultOperatingSystem: "linux",
    keywords: ["lakehouse", "enterprise data lake", "data lake", "redshift", "athena", "glue"],
    requiredCapabilities: ["object storage", "metadata catalog", "sql query", "warehouse serving"],
    budgetGuidance: {
      minimumMonthlyUsd: 15_000,
      preferredMinMonthlyUsd: 20_000,
      preferredMaxMonthlyUsd: 80_000,
    },
    signalProfile: {
      boost: ["data-lake", "lakehouse", "warehouse", "analytics"],
      penalize: ["windows", "containers"],
      requireAny: ["data-lake", "lakehouse", "warehouse"],
    },
    packIds: ["observability", "private-networking"],
    requiredServiceIds: [
      "amazon-s3",
      "amazon-athena",
      "amazon-redshift",
      "aws-glue-etl",
      "aws-glue-data-catalog",
    ],
    optionalServiceIds: ["aws-glue-crawlers", "amazon-kinesis-firehose", "amazon-vpc-endpoints"],
    addOnAllocations: {
      "amazon-cloudwatch": 0.015,
      "aws-glue-crawlers": 0.02,
      "amazon-kinesis-firehose": 0.05,
      "amazon-vpc-endpoints": 0.03,
    },
    coreBudgetWeights: {
      "amazon-s3": 0.34,
      "amazon-athena": 0.1,
      "amazon-redshift": 0.34,
      "aws-glue-etl": 0.16,
      "aws-glue-data-catalog": 0.06,
    },
    requiredServiceFamilies: ["storage", "analytics", "integration", "metadata"],
    primaryServiceIds: [
      "amazon-s3",
      "amazon-redshift",
      "amazon-athena",
      "aws-glue-etl",
      "aws-glue-data-catalog",
    ],
    forbiddenServiceIds: ["amazon-ec2", "amazon-rds-postgresql"],
    serviceRoles: {
      "amazon-s3": {
        role: "lake-storage",
        rationale: "Stores raw and curated datasets for the lakehouse.",
      },
      "amazon-athena": {
        role: "exploration-query",
        rationale: "Supports ad hoc exploration over lake data.",
      },
      "amazon-redshift": {
        role: "serving-warehouse",
        rationale: "Provides the warehouse serving layer for curated analytics.",
      },
      "aws-glue-etl": {
        role: "data-transforms",
        rationale: "Runs ETL jobs that prepare curated warehouse-ready datasets.",
      },
      "aws-glue-data-catalog": {
        role: "metadata-catalog",
        rationale: "Stores shared table and schema metadata.",
      },
    },
  }),
  "streaming-data-platform": composeBlueprint({
    id: "streaming-data-platform",
    title: "Streaming Data Platform",
    description:
      "Streaming analytics platform with Firehose ingestion, S3 landing, Athena query, and Glue preparation services.",
    templateId: "streaming-data-platform-standard",
    architectureFamily: "data-platform",
    architectureSubtype: "streaming-data-platform",
    environmentModel: "shared",
    defaultOperatingSystem: "linux",
    keywords: ["streaming", "real-time", "firehose", "events", "ingestion", "analytics"],
    requiredCapabilities: ["stream ingestion", "object storage", "metadata catalog", "sql query"],
    budgetGuidance: {
      minimumMonthlyUsd: 12_000,
      preferredMinMonthlyUsd: 18_000,
      preferredMaxMonthlyUsd: 75_000,
    },
    signalProfile: {
      boost: ["streaming", "eventing", "analytics"],
      penalize: ["windows", "containers"],
      requireAny: ["streaming", "eventing"],
    },
    packIds: ["observability", "private-networking"],
    requiredServiceIds: [
      "amazon-s3",
      "amazon-kinesis-firehose",
      "aws-glue-etl",
      "aws-glue-data-catalog",
      "amazon-athena",
    ],
    optionalServiceIds: ["aws-glue-crawlers", "amazon-vpc-endpoints", "amazon-redshift"],
    addOnAllocations: {
      "amazon-cloudwatch": 0.02,
      "aws-glue-crawlers": 0.015,
      "amazon-vpc-endpoints": 0.03,
      "amazon-redshift": 0.12,
    },
    coreBudgetWeights: {
      "amazon-s3": 0.32,
      "amazon-kinesis-firehose": 0.24,
      "aws-glue-etl": 0.2,
      "aws-glue-data-catalog": 0.06,
      "amazon-athena": 0.18,
    },
    requiredServiceFamilies: ["storage", "analytics", "integration", "metadata"],
    primaryServiceIds: [
      "amazon-kinesis-firehose",
      "amazon-s3",
      "aws-glue-etl",
      "aws-glue-data-catalog",
      "amazon-athena",
    ],
    forbiddenServiceIds: ["amazon-ec2", "amazon-rds-postgresql"],
    serviceRoles: {
      "amazon-kinesis-firehose": {
        role: "stream-ingestion",
        rationale: "Ingests streaming data into the analytics landing zone.",
      },
      "amazon-s3": {
        role: "streaming-landing-zone",
        rationale: "Stores landed streaming data for durable analytics processing.",
      },
      "aws-glue-etl": {
        role: "stream-preparation",
        rationale: "Transforms landed data into analytics-ready datasets.",
      },
      "aws-glue-data-catalog": {
        role: "metadata-catalog",
        rationale: "Maintains schema metadata for streaming datasets.",
      },
      "amazon-athena": {
        role: "analytics-query",
        rationale: "Provides SQL query over streaming data stored in S3.",
      },
    },
  }),
  "warehouse-centric-analytics": composeBlueprint({
    id: "warehouse-centric-analytics",
    title: "Warehouse-Centric Analytics",
    description:
      "Warehouse-first analytics stack with Redshift serving over curated S3 data and Glue preparation services.",
    templateId: "warehouse-centric-analytics-standard",
    architectureFamily: "data-platform",
    architectureSubtype: "warehouse-centric-analytics",
    environmentModel: "shared",
    defaultOperatingSystem: "linux",
    keywords: ["warehouse", "redshift", "bi", "analytics", "reporting"],
    requiredCapabilities: ["warehouse serving", "curated storage", "metadata catalog", "batch transforms"],
    budgetGuidance: {
      minimumMonthlyUsd: 14_000,
      preferredMinMonthlyUsd: 18_000,
      preferredMaxMonthlyUsd: 70_000,
    },
    signalProfile: {
      boost: ["warehouse", "analytics", "bi"],
      penalize: ["windows", "containers", "streaming"],
      requireAny: ["warehouse", "analytics"],
    },
    packIds: ["observability", "private-networking"],
    requiredServiceIds: [
      "amazon-s3",
      "amazon-redshift",
      "aws-glue-etl",
      "aws-glue-data-catalog",
    ],
    defaultAddOnServiceIds: ["amazon-cloudwatch"],
    optionalServiceIds: ["amazon-athena", "aws-glue-crawlers", "amazon-vpc-endpoints"],
    addOnAllocations: {
      "amazon-athena": 0.05,
      "aws-glue-crawlers": 0.015,
      "amazon-vpc-endpoints": 0.03,
    },
    coreBudgetWeights: {
      "amazon-redshift": 0.54,
      "amazon-s3": 0.22,
      "aws-glue-etl": 0.18,
      "aws-glue-data-catalog": 0.06,
    },
    requiredServiceFamilies: ["storage", "analytics", "integration", "metadata"],
    primaryServiceIds: [
      "amazon-redshift",
      "amazon-s3",
      "aws-glue-etl",
      "aws-glue-data-catalog",
    ],
    forbiddenServiceIds: ["amazon-ec2", "amazon-rds-postgresql"],
    serviceRoles: {
      "amazon-redshift": {
        role: "serving-warehouse",
        rationale: "Provides the primary analytics serving and BI query layer.",
      },
      "amazon-s3": {
        role: "curated-storage",
        rationale: "Stores staged and curated analytics datasets.",
      },
      "aws-glue-etl": {
        role: "data-transforms",
        rationale: "Prepares curated data for the warehouse serving layer.",
      },
      "aws-glue-data-catalog": {
        role: "metadata-catalog",
        rationale: "Stores shared metadata for warehouse and lake datasets.",
      },
    },
  }),
};

function composePattern({
  id,
  blueprintId,
  title,
  description,
  templateId = null,
  coreStrategy = null,
  environmentModel = null,
  defaultOperatingSystem = null,
  keywords = [],
  traits = [],
  requiredCapabilities = null,
  budgetGuidance = null,
  requiredServiceFamilies = null,
  requiredServiceIds = null,
  defaultAddOnServiceIds = null,
  optionalServiceIds = null,
  addOnAllocations = null,
  primaryServiceIds = null,
  forbiddenServiceIds = null,
  coreBudgetWeights = null,
  serviceRoles = {},
  requiredUnpricedCapabilities = [],
}) {
  return {
    id,
    blueprintId,
    title,
    description,
    templateId,
    coreStrategy,
    environmentModel,
    defaultOperatingSystem,
    keywords: [...keywords],
    traits: [...traits],
    requiredCapabilities: requiredCapabilities ? [...requiredCapabilities] : null,
    budgetGuidance: budgetGuidance ? { ...budgetGuidance } : null,
    requiredServiceFamilies: requiredServiceFamilies ? [...requiredServiceFamilies] : null,
    requiredServiceIds: requiredServiceIds ? dedupe(requiredServiceIds) : null,
    defaultAddOnServiceIds: defaultAddOnServiceIds ? dedupe(defaultAddOnServiceIds) : null,
    optionalServiceIds: optionalServiceIds ? dedupe(optionalServiceIds) : null,
    addOnAllocations: addOnAllocations ? { ...addOnAllocations } : null,
    primaryServiceIds: primaryServiceIds ? dedupe(primaryServiceIds) : null,
    forbiddenServiceIds: forbiddenServiceIds ? dedupe(forbiddenServiceIds) : null,
    coreBudgetWeights: coreBudgetWeights ? { ...coreBudgetWeights } : null,
    serviceRoles: { ...serviceRoles },
    requiredUnpricedCapabilities: requiredUnpricedCapabilities.map((capability) => ({ ...capability })),
  };
}

const ARCHITECTURE_PATTERNS = {
  "container-platform": [
    composePattern({
      id: "eks-app-platform",
      blueprintId: "container-platform",
      title: "EKS App Platform",
      description: "Default container application platform with relational data and shared edge add-ons.",
      traits: ["containers", "relational"],
      keywords: ["eks", "kubernetes", "argocd", "postgres", "dynamodb", "sidecar", "internal platform"],
    }),
    composePattern({
      id: "eks-api-front-door",
      blueprintId: "container-platform",
      title: "EKS API Front Door",
      description: "EKS-backed application platform with managed API ingress in front of the container runtime.",
      templateId: "container-api-front-door-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["containers", "api", "relational"],
      keywords: ["api gateway", "api", "container platform", "postgres"],
      requiredCapabilities: ["container orchestration", "managed api ingress", "relational data"],
      requiredServiceIds: [
        "amazon-eks",
        "amazon-ec2",
        "amazon-rds-postgresql",
        "amazon-api-gateway-http",
      ],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["application-load-balancer", "amazon-route53", "amazon-s3"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "application-load-balancer": 0.04,
        "amazon-route53": 0.01,
        "amazon-s3": 0.02,
      },
      primaryServiceIds: [
        "amazon-eks",
        "amazon-ec2",
        "amazon-rds-postgresql",
        "amazon-api-gateway-http",
      ],
      coreBudgetWeights: {
        "amazon-eks": 0.01,
        "amazon-ec2": 0.56,
        "amazon-rds-postgresql": 0.08,
        "amazon-api-gateway-http": 0.35,
      },
      serviceRoles: {
        "amazon-api-gateway-http": {
          role: "managed-api-ingress",
          rationale: "Publishes the managed API front door requested for the container platform.",
        },
      },
    }),
    composePattern({
      id: "eks-private-service",
      blueprintId: "container-platform",
      title: "EKS Private Service",
      description: "Private EKS service pattern with NLB ingress and PrivateLink endpoints.",
      templateId: "container-private-service-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["containers", "private", "relational"],
      keywords: ["privatelink", "private", "nlb", "endpoint"],
      requiredCapabilities: ["container orchestration", "private ingress", "relational data"],
      requiredServiceIds: [
        "amazon-eks",
        "amazon-ec2",
        "amazon-rds-postgresql",
        "network-load-balancer",
        "amazon-vpc-endpoints",
      ],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["amazon-route53"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "amazon-route53": 0.01,
      },
      primaryServiceIds: [
        "amazon-eks",
        "amazon-ec2",
        "network-load-balancer",
        "amazon-vpc-endpoints",
      ],
      forbiddenServiceIds: ["application-load-balancer", "amazon-cloudfront", "amazon-vpc-nat"],
      coreBudgetWeights: {
        "amazon-eks": 0.01,
        "amazon-ec2": 0.26,
        "amazon-rds-postgresql": 0.08,
        "network-load-balancer": 0.27,
        "amazon-vpc-endpoints": 0.38,
      },
      serviceRoles: {
        "network-load-balancer": {
          role: "private-service-ingress",
          rationale: "Provides private service ingress for the EKS workloads.",
        },
        "amazon-vpc-endpoints": {
          role: "privatelink-endpoints",
          rationale: "Provides private endpoint connectivity for internal consumers.",
        },
      },
    }),
    composePattern({
      id: "eks-search-content-platform",
      blueprintId: "container-platform",
      title: "EKS Search and Content Platform",
      description: "EKS application pattern with OpenSearch search services and S3 asset storage.",
      templateId: "container-search-content-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["containers", "search", "content"],
      keywords: ["opensearch", "search", "s3", "assets", "content"],
      requiredCapabilities: ["container orchestration", "search", "object asset storage"],
      requiredServiceIds: ["amazon-eks", "amazon-ec2", "amazon-opensearch", "amazon-s3"],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["application-load-balancer", "amazon-route53"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "application-load-balancer": 0.03,
        "amazon-route53": 0.01,
      },
      primaryServiceIds: ["amazon-eks", "amazon-ec2", "amazon-opensearch", "amazon-s3"],
      forbiddenServiceIds: ["amazon-redshift", "amazon-athena"],
      coreBudgetWeights: {
        "amazon-eks": 0.01,
        "amazon-ec2": 0.29,
        "amazon-opensearch": 0.35,
        "amazon-s3": 0.35,
      },
      serviceRoles: {
        "amazon-opensearch": {
          role: "search-index",
          rationale: "Provides the managed search tier requested for the application content.",
        },
        "amazon-s3": {
          role: "asset-storage",
          rationale: "Stores static assets and content blobs for the platform.",
        },
      },
    }),
  ],
  "linux-web-stack": [
    composePattern({
      id: "ec2-web-with-postgres",
      blueprintId: "linux-web-stack",
      title: "EC2 Web with PostgreSQL",
      description: "Default Linux web stack with EC2 and PostgreSQL.",
      traits: ["linux-web", "relational"],
      keywords: ["linux", "web", "postgres"],
    }),
    composePattern({
      id: "ec2-web-with-cdn",
      blueprintId: "linux-web-stack",
      title: "EC2 Web with CDN",
      description: "Linux EC2 web stack with CloudFront delivery in front of the application tier.",
      templateId: "linux-web-cdn-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["linux-web", "cdn", "relational"],
      keywords: ["cloudfront", "cdn", "web", "route53"],
      requiredCapabilities: ["vm runtime", "cdn delivery", "relational data"],
      requiredServiceIds: [
        "amazon-ec2",
        "amazon-rds-postgresql",
        "amazon-cloudfront",
      ],
      defaultAddOnServiceIds: ["application-load-balancer", "amazon-route53", "amazon-cloudwatch"],
      optionalServiceIds: ["amazon-s3"],
      addOnAllocations: {
        "application-load-balancer": 0.04,
        "amazon-route53": 0.01,
        "amazon-cloudwatch": 0.015,
        "amazon-s3": 0.02,
      },
      primaryServiceIds: [
        "amazon-ec2",
        "amazon-rds-postgresql",
        "amazon-cloudfront",
      ],
      coreBudgetWeights: {
        "amazon-ec2": 0.46,
        "amazon-rds-postgresql": 0.3,
        "amazon-cloudfront": 0.24,
      },
      serviceRoles: {
        "amazon-cloudfront": {
          role: "cdn-delivery",
          rationale: "Provides CDN delivery in front of the Linux application tier.",
        },
      },
    }),
    composePattern({
      id: "ec2-web-with-private-service",
      blueprintId: "linux-web-stack",
      title: "EC2 Private Service",
      description: "Linux EC2 service pattern with private ingress through NLB and PrivateLink endpoints.",
      templateId: "linux-web-private-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["linux-web", "private"],
      keywords: ["privatelink", "private", "nlb", "fleet"],
      requiredCapabilities: ["vm runtime", "private ingress"],
      requiredServiceIds: ["amazon-ec2", "network-load-balancer", "amazon-vpc-endpoints"],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["amazon-route53", "amazon-rds-postgresql"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "amazon-route53": 0.01,
        "amazon-rds-postgresql": 0.12,
      },
      primaryServiceIds: ["amazon-ec2", "network-load-balancer", "amazon-vpc-endpoints"],
      forbiddenServiceIds: ["application-load-balancer", "amazon-cloudfront", "amazon-vpc-nat"],
      coreBudgetWeights: {
        "amazon-ec2": 0.46,
        "network-load-balancer": 0.28,
        "amazon-vpc-endpoints": 0.26,
      },
      serviceRoles: {
        "network-load-balancer": {
          role: "private-service-ingress",
          rationale: "Provides private ingress to the Linux service tier.",
        },
        "amazon-vpc-endpoints": {
          role: "privatelink-endpoints",
          rationale: "Provides private endpoint connectivity for consumers of the Linux service.",
        },
      },
    }),
  ],
  "windows-app-stack": [
    composePattern({
      id: "windows-iis-with-postgres",
      blueprintId: "windows-app-stack",
      title: "Windows IIS with PostgreSQL",
      description: "Default Windows application stack with IIS and PostgreSQL.",
      traits: ["windows", "relational"],
      keywords: ["windows", "iis", "postgres"],
    }),
    composePattern({
      id: "windows-iis-with-sqlserver",
      blueprintId: "windows-app-stack",
      title: "Windows IIS with SQL Server",
      description: "Windows application stack centered on SQL Server rather than PostgreSQL.",
      templateId: "windows-sqlserver-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["windows", "sqlserver"],
      keywords: ["windows", "iis", "sql server", ".net", "dotnet"],
      requiredCapabilities: ["windows runtime", "sql server data", "application ingress"],
      requiredServiceFamilies: ["compute", "database"],
      requiredServiceIds: ["amazon-ec2", "amazon-rds-sqlserver"],
      defaultAddOnServiceIds: ["application-load-balancer", "amazon-cloudwatch"],
      optionalServiceIds: ["aws-waf-v2", "amazon-route53", "amazon-fsx-windows", "amazon-s3"],
      addOnAllocations: {
        "application-load-balancer": 0.04,
        "amazon-cloudwatch": 0.015,
        "aws-waf-v2": 0.015,
        "amazon-route53": 0.01,
        "amazon-fsx-windows": 0.05,
        "amazon-s3": 0.02,
      },
      primaryServiceIds: ["amazon-ec2", "amazon-rds-sqlserver"],
      forbiddenServiceIds: ["amazon-rds-postgresql"],
      coreBudgetWeights: {
        "amazon-ec2": 0.68,
        "amazon-rds-sqlserver": 0.32,
      },
      serviceRoles: {
        "amazon-ec2": {
          role: "windows-runtime",
          rationale: "Runs the primary Windows application workload.",
        },
        "amazon-rds-sqlserver": {
          role: "sqlserver-database",
          rationale: "Provides the Microsoft SQL Server data layer requested by the workload.",
        },
      },
    }),
    composePattern({
      id: "windows-files-app",
      blueprintId: "windows-app-stack",
      title: "Windows File-Centric Application",
      description: "Windows application stack with SMB file shares and optional object storage.",
      templateId: "windows-files-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["windows", "files"],
      keywords: ["windows", "smb", "file share", "fsx"],
      requiredCapabilities: ["windows runtime", "shared file storage"],
      requiredServiceFamilies: ["compute", "storage"],
      requiredServiceIds: ["amazon-ec2", "amazon-fsx-windows"],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["amazon-s3", "application-load-balancer", "amazon-route53"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "amazon-s3": 0.03,
        "application-load-balancer": 0.03,
        "amazon-route53": 0.01,
      },
      primaryServiceIds: ["amazon-ec2", "amazon-fsx-windows"],
      forbiddenServiceIds: ["amazon-rds-postgresql"],
      coreBudgetWeights: {
        "amazon-ec2": 0.86,
        "amazon-fsx-windows": 0.14,
      },
      serviceRoles: {
        "amazon-ec2": {
          role: "windows-runtime",
          rationale: "Runs the Windows application and SMB clients.",
        },
        "amazon-fsx-windows": {
          role: "shared-file-storage",
          rationale: "Provides SMB-compatible shared file storage for the workload.",
        },
      },
    }),
    composePattern({
      id: "windows-private-sql-service",
      blueprintId: "windows-app-stack",
      title: "Windows Private SQL Service",
      description: "Private Windows service with SQL Server and private-connectivity controls.",
      templateId: "windows-sqlserver-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["windows", "sqlserver", "private"],
      keywords: ["windows", "sql server", "privatelink", "private"],
      requiredCapabilities: ["windows runtime", "sql server data", "private connectivity"],
      requiredServiceFamilies: ["compute", "database", "networking"],
      requiredServiceIds: ["amazon-ec2", "amazon-rds-sqlserver", "amazon-vpc-endpoints"],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["network-load-balancer", "amazon-fsx-windows"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.012,
        "network-load-balancer": 0.04,
        "amazon-fsx-windows": 0.04,
      },
      primaryServiceIds: ["amazon-ec2", "amazon-rds-sqlserver", "amazon-vpc-endpoints"],
      forbiddenServiceIds: ["amazon-rds-postgresql", "amazon-vpc-nat", "application-load-balancer"],
      coreBudgetWeights: {
        "amazon-ec2": 0.56,
        "amazon-rds-sqlserver": 0.24,
        "amazon-vpc-endpoints": 0.2,
      },
      serviceRoles: {
        "amazon-vpc-endpoints": {
          role: "private-connectivity",
          rationale: "Provides the private connectivity path requested by the workload.",
        },
      },
    }),
  ],
  "edge-api-platform": [
    composePattern({
      id: "serverless-edge-api",
      blueprintId: "edge-api-platform",
      title: "Serverless Edge API",
      description: "CloudFront + API Gateway + Lambda + DynamoDB edge-native API platform.",
      templateId: "edge-api-serverless-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["edge", "api", "serverless"],
      keywords: ["edge", "api", "serverless", "cloudfront", "lambda", "dynamodb", "route53"],
      requiredCapabilities: ["edge delivery", "api runtime", "managed state"],
      requiredServiceFamilies: ["edge", "compute", "database"],
      requiredServiceIds: [
        "amazon-cloudfront",
        "amazon-api-gateway-http",
        "amazon-lambda",
        "amazon-dynamodb",
      ],
      defaultAddOnServiceIds: ["amazon-route53", "amazon-cloudwatch"],
      optionalServiceIds: ["aws-waf-v2", "amazon-eventbridge", "amazon-sqs", "amazon-sns"],
      addOnAllocations: {
        "amazon-route53": 0.01,
        "amazon-cloudwatch": 0.015,
        "aws-waf-v2": 0.02,
        "amazon-eventbridge": 0.02,
        "amazon-sqs": 0.015,
        "amazon-sns": 0.015,
      },
      primaryServiceIds: [
        "amazon-cloudfront",
        "amazon-api-gateway-http",
        "amazon-lambda",
        "amazon-dynamodb",
      ],
      forbiddenServiceIds: ["amazon-ec2", "amazon-rds-postgresql", "amazon-vpc-nat"],
      coreBudgetWeights: {
        "amazon-cloudfront": 0.24,
        "amazon-api-gateway-http": 0.18,
        "amazon-lambda": 0.32,
        "amazon-dynamodb": 0.26,
      },
      serviceRoles: {
        "amazon-cloudfront": {
          role: "edge-delivery",
          rationale: "Delivers the API and cached assets at the edge.",
        },
        "amazon-api-gateway-http": {
          role: "api-front-door",
          rationale: "Publishes the managed API ingress for the platform.",
        },
        "amazon-lambda": {
          role: "serverless-runtime",
          rationale: "Runs request and background logic without persistent servers.",
        },
        "amazon-dynamodb": {
          role: "managed-state-store",
          rationale: "Provides low-latency managed application state.",
        },
      },
    }),
    composePattern({
      id: "cloudfront-alb-origin-app",
      blueprintId: "edge-api-platform",
      title: "CloudFront ALB Origin App",
      description: "CloudFront front door backed by ALB origins, with optional WAF and serverless side-services.",
      templateId: "edge-origin-platform-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["edge", "origin"],
      keywords: ["cloudfront", "alb", "origin", "waf"],
      requiredCapabilities: ["edge delivery", "origin routing"],
      requiredServiceFamilies: ["edge", "networking"],
      requiredServiceIds: ["amazon-cloudfront", "application-load-balancer"],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["aws-waf-v2", "amazon-route53", "amazon-api-gateway-http", "amazon-lambda"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "aws-waf-v2": 0.02,
        "amazon-route53": 0.01,
        "amazon-api-gateway-http": 0.08,
        "amazon-lambda": 0.06,
      },
      primaryServiceIds: ["amazon-cloudfront", "application-load-balancer"],
      forbiddenServiceIds: ["amazon-rds-postgresql", "amazon-vpc-nat"],
      coreBudgetWeights: {
        "amazon-cloudfront": 0.52,
        "application-load-balancer": 0.48,
      },
    }),
    composePattern({
      id: "private-api-front-door",
      blueprintId: "edge-api-platform",
      title: "Private API Front Door",
      description: "Private API ingress pattern using API Gateway, NLB, and VPC endpoints.",
      templateId: "private-api-front-door-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["api", "private"],
      keywords: ["private", "privatelink", "private api", "nlb", "endpoint"],
      requiredCapabilities: ["api runtime", "private connectivity"],
      requiredServiceFamilies: ["edge", "networking"],
      requiredServiceIds: ["amazon-api-gateway-http", "network-load-balancer", "amazon-vpc-endpoints"],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["aws-waf-v2", "amazon-cloudfront"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "aws-waf-v2": 0.02,
        "amazon-cloudfront": 0.06,
      },
      primaryServiceIds: ["amazon-api-gateway-http", "network-load-balancer", "amazon-vpc-endpoints"],
      forbiddenServiceIds: ["application-load-balancer", "amazon-rds-postgresql", "amazon-vpc-nat"],
      coreBudgetWeights: {
        "amazon-api-gateway-http": 0.28,
        "network-load-balancer": 0.34,
        "amazon-vpc-endpoints": 0.38,
      },
      serviceRoles: {
        "network-load-balancer": {
          role: "private-origin-ingress",
          rationale: "Exposes the private origin/service path required for private connectivity.",
        },
        "amazon-vpc-endpoints": {
          role: "privatelink-endpoints",
          rationale: "Provides private endpoint connectivity for the API path.",
        },
      },
    }),
  ],
  "event-driven-platform": [
    composePattern({
      id: "async-worker-platform",
      blueprintId: "event-driven-platform",
      title: "Async Worker Platform",
      description: "Lambda and SQS centered async processing platform.",
      templateId: "event-driven-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["eventing", "async", "serverless"],
      keywords: ["async", "jobs", "queue", "sqs", "lambda"],
      requiredCapabilities: ["queueing", "worker runtime"],
      requiredServiceFamilies: ["compute", "integration"],
      requiredServiceIds: ["amazon-lambda", "amazon-sqs"],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["amazon-sns", "amazon-eventbridge", "amazon-rds-postgresql"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "amazon-sns": 0.05,
        "amazon-eventbridge": 0.04,
        "amazon-rds-postgresql": 0.12,
      },
      primaryServiceIds: ["amazon-lambda", "amazon-sqs", "amazon-sns", "amazon-eventbridge"],
      forbiddenServiceIds: ["amazon-ec2", "amazon-vpc-nat"],
      coreBudgetWeights: {
        "amazon-lambda": 0.6,
        "amazon-sqs": 0.4,
      },
    }),
    composePattern({
      id: "pubsub-fanout-platform",
      blueprintId: "event-driven-platform",
      title: "Pub/Sub Fanout Platform",
      description: "SNS/Lambda centered fanout and notification platform.",
      templateId: "event-driven-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["eventing", "pubsub", "serverless"],
      keywords: ["sns", "fanout", "notifications", "notification", "pubsub", "redis"],
      requiredCapabilities: ["fanout messaging", "event workers"],
      requiredServiceFamilies: ["compute", "integration"],
      requiredServiceIds: ["amazon-lambda", "amazon-sns"],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["amazon-sqs", "amazon-eventbridge", "amazon-elasticache-redis", "amazon-rds-postgresql"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "amazon-sqs": 0.05,
        "amazon-eventbridge": 0.03,
        "amazon-elasticache-redis": 0.08,
        "amazon-rds-postgresql": 0.1,
      },
      primaryServiceIds: ["amazon-lambda", "amazon-sns", "amazon-sqs", "amazon-eventbridge"],
      forbiddenServiceIds: ["amazon-ec2", "amazon-vpc-nat"],
      coreBudgetWeights: {
        "amazon-lambda": 0.48,
        "amazon-sns": 0.34,
        "amazon-sqs": 0.18,
      },
    }),
    composePattern({
      id: "event-bus-integration-platform",
      blueprintId: "event-driven-platform",
      title: "Event Bus Integration Platform",
      description: "EventBridge-centered integration platform with queueing and optional API ingress.",
      templateId: "event-driven-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["eventing", "integration", "api", "serverless"],
      keywords: ["eventbridge", "integration", "api gateway", "queueing", "postgresql"],
      requiredCapabilities: ["event routing", "queueing", "integration ingress"],
      requiredServiceFamilies: ["compute", "integration", "edge"],
      requiredServiceIds: ["amazon-eventbridge", "amazon-sqs", "amazon-api-gateway-http"],
      defaultAddOnServiceIds: ["amazon-cloudwatch"],
      optionalServiceIds: ["amazon-lambda", "amazon-sns", "amazon-rds-postgresql"],
      addOnAllocations: {
        "amazon-cloudwatch": 0.015,
        "amazon-lambda": 0.08,
        "amazon-sns": 0.05,
        "amazon-rds-postgresql": 0.1,
      },
      primaryServiceIds: ["amazon-eventbridge", "amazon-sqs", "amazon-api-gateway-http", "amazon-lambda"],
      forbiddenServiceIds: ["amazon-ec2", "amazon-vpc-nat"],
      coreBudgetWeights: {
        "amazon-eventbridge": 0.34,
        "amazon-sqs": 0.32,
        "amazon-api-gateway-http": 0.2,
        "amazon-lambda": 0.14,
      },
    }),
  ],
  "modernization-platform": [
    composePattern({
      id: "hybrid-transition-state",
      blueprintId: "modernization-platform",
      title: "Hybrid Transition State",
      description: "Transitional modernization state with Fargate growth and residual EC2 workloads.",
      traits: ["modernization", "transition"],
      keywords: ["modernization", "migration", "transition"],
    }),
    composePattern({
      id: "ecs-fargate-target-state",
      blueprintId: "modernization-platform",
      title: "ECS Fargate Target State",
      description: "Fargate-led modernization target state with managed storage and private-connectivity add-ons.",
      templateId: "modernization-fargate-standard",
      coreStrategy: "weighted-services",
      environmentModel: "shared",
      traits: ["modernization", "fargate"],
      keywords: ["fargate", "ecs", "modernization", "migration", "refactor"],
      requiredCapabilities: ["modernized runtime", "service ingress", "managed persistence"],
      requiredServiceFamilies: ["compute", "database"],
      requiredServiceIds: ["amazon-ecs-fargate", "amazon-rds-postgresql"],
      defaultAddOnServiceIds: ["application-load-balancer", "amazon-cloudwatch"],
      optionalServiceIds: [
        "amazon-efs",
        "amazon-ebs",
        "amazon-vpc-endpoints",
        "amazon-elasticache-redis",
        "network-load-balancer",
      ],
      addOnAllocations: {
        "application-load-balancer": 0.04,
        "amazon-cloudwatch": 0.015,
        "amazon-efs": 0.05,
        "amazon-ebs": 0.04,
        "amazon-vpc-endpoints": 0.04,
        "amazon-elasticache-redis": 0.06,
        "network-load-balancer": 0.03,
      },
      primaryServiceIds: ["amazon-ecs-fargate", "amazon-rds-postgresql"],
      forbiddenServiceIds: ["amazon-vpc-nat"],
      coreBudgetWeights: {
        "amazon-ecs-fargate": 0.82,
        "amazon-rds-postgresql": 0.18,
      },
      serviceRoles: {
        "amazon-ecs-fargate": {
          role: "modernized-runtime",
          rationale: "Hosts the target-state containerized runtime.",
        },
      },
    }),
  ],
  "lake-foundation": [
    composePattern({
      id: "lake-foundation-basic",
      blueprintId: "lake-foundation",
      title: "Lake Foundation Basic",
      description: "Default lake foundation with S3, Glue catalog/crawlers, ETL, and Athena.",
      traits: ["data-lake"],
      keywords: ["data lake", "athena", "glue", "catalog", "crawler"],
    }),
    composePattern({
      id: "lake-foundation-governed",
      blueprintId: "lake-foundation",
      title: "Governed Lake Foundation",
      description: "Lake foundation with an explicit governance requirement layered over S3, Glue, and Athena.",
      traits: ["data-lake", "governed"],
      keywords: ["governed", "governance", "lake formation"],
      requiredUnpricedCapabilities: [
        {
          id: "lake-formation-governance",
          title: "Lake governance layer",
          details:
            "The prompt implies a governance layer such as AWS Lake Formation, which is not yet modeled in the exact pricing path.",
        },
      ],
    }),
  ],
  "streaming-data-platform": [
    composePattern({
      id: "stream-analytics-platform",
      blueprintId: "streaming-data-platform",
      title: "Stream Analytics Platform",
      description: "Streaming analytics design that requires a true stream-processing engine in addition to ingestion and lake query services.",
      traits: ["streaming", "stream-processing"],
      keywords: ["real-time", "streaming analytics", "stream analytics", "continuous"],
      requiredUnpricedCapabilities: [
        {
          id: "stream-processing-engine",
          title: "Real-time stream processing",
          details:
            "The prompt implies a real-time stream-processing layer such as Managed Service for Apache Flink, which is not yet modeled in the exact pricing path.",
        },
      ],
    }),
  ],
  "lakehouse-platform": [
    composePattern({
      id: "lakehouse-serving",
      blueprintId: "lakehouse-platform",
      title: "Lakehouse Serving",
      description: "Default lakehouse architecture with S3, Athena, Glue, and Redshift serving.",
      traits: ["lakehouse", "warehouse"],
      keywords: ["lakehouse", "enterprise data lakehouse", "redshift", "athena", "curated"],
    }),
  ],
  "warehouse-centric-analytics": [
    composePattern({
      id: "redshift-bi-warehouse",
      blueprintId: "warehouse-centric-analytics",
      title: "Redshift BI Warehouse",
      description: "Default Redshift-centric BI warehouse over curated S3 data.",
      traits: ["warehouse"],
      keywords: ["warehouse", "redshift", "bi", "reporting"],
    }),
  ],
};

export function supportedTemplateIds() {
  return Object.keys(TEMPLATE_METADATA);
}

export function supportedBlueprintIds() {
  return Object.keys(BLUEPRINTS);
}

export function candidateBlueprintIds() {
  return Object.values(BLUEPRINTS)
    .filter((blueprint) => blueprint.candidateEligible !== false)
    .map((blueprint) => blueprint.id);
}

export function supportedRegions() {
  return [...DESIGN_REGIONS];
}

export function getTemplate(templateId) {
  const template = TEMPLATE_METADATA[templateId];

  if (!template) {
    throw new Error(
      `Unknown template '${templateId}'. Supported templates: ${supportedTemplateIds().join(", ")}.`,
    );
  }

  return template;
}

export function getBlueprint(blueprintId) {
  const blueprint = BLUEPRINTS[blueprintId];

  if (!blueprint) {
    throw new Error(
      `Unknown blueprint '${blueprintId}'. Supported blueprints: ${supportedBlueprintIds().join(", ")}.`,
    );
  }

  return blueprint;
}

export function patternIdsForBlueprint(blueprintId) {
  return (ARCHITECTURE_PATTERNS[blueprintId] ?? []).map((pattern) => pattern.id);
}

export function getArchitecturePattern(blueprintId, patternId) {
  const pattern = (ARCHITECTURE_PATTERNS[blueprintId] ?? []).find(
    (candidate) => candidate.id === patternId,
  );

  if (!pattern) {
    throw new Error(
      `Unknown pattern '${patternId}' for blueprint '${blueprintId}'. Supported patterns: ${patternIdsForBlueprint(blueprintId).join(", ") || "none"}.`,
    );
  }

  return {
    ...pattern,
    keywords: [...pattern.keywords],
    traits: [...pattern.traits],
    requiredCapabilities: pattern.requiredCapabilities ? [...pattern.requiredCapabilities] : null,
    budgetGuidance: pattern.budgetGuidance ? { ...pattern.budgetGuidance } : null,
    requiredServiceFamilies: pattern.requiredServiceFamilies
      ? [...pattern.requiredServiceFamilies]
      : null,
    requiredServiceIds: pattern.requiredServiceIds ? [...pattern.requiredServiceIds] : null,
    defaultAddOnServiceIds: pattern.defaultAddOnServiceIds
      ? [...pattern.defaultAddOnServiceIds]
      : null,
    optionalServiceIds: pattern.optionalServiceIds ? [...pattern.optionalServiceIds] : null,
    addOnAllocations: pattern.addOnAllocations ? { ...pattern.addOnAllocations } : null,
    primaryServiceIds: pattern.primaryServiceIds ? [...pattern.primaryServiceIds] : null,
    forbiddenServiceIds: pattern.forbiddenServiceIds ? [...pattern.forbiddenServiceIds] : null,
    coreBudgetWeights: pattern.coreBudgetWeights ? { ...pattern.coreBudgetWeights } : null,
    serviceRoles: { ...pattern.serviceRoles },
    requiredUnpricedCapabilities: pattern.requiredUnpricedCapabilities.map((capability) => ({
      ...capability,
    })),
  };
}

export function listArchitecturePatterns(blueprintId) {
  return (ARCHITECTURE_PATTERNS[blueprintId] ?? []).map((pattern) =>
    getArchitecturePattern(blueprintId, pattern.id),
  );
}

export function resolveBlueprintIdForTemplate(templateId) {
  return getTemplate(templateId).blueprintId;
}

export function listBlueprintCatalog() {
  return Object.values(BLUEPRINTS)
    .filter((blueprint) => blueprint.visible !== false)
    .map((blueprint) => ({
    id: blueprint.id,
    title: blueprint.title,
    description: blueprint.description,
    architectureFamily: blueprint.architectureFamily,
    architectureSubtype: blueprint.architectureSubtype,
    environmentModel: blueprint.environmentModel,
    defaultOperatingSystem: blueprint.defaultOperatingSystem,
    requiredCapabilities: [...(blueprint.requiredCapabilities ?? [])],
    budgetGuidance: blueprint.budgetGuidance ? { ...blueprint.budgetGuidance } : null,
    packIds: [...(blueprint.packIds ?? [])],
    packs: blueprint.packs.map((pack) => ({ ...pack })),
    requiredServiceFamilies: [...(blueprint.requiredServiceFamilies ?? [])],
    requiredServiceIds: [...blueprint.requiredServiceIds],
    defaultAddOnServiceIds: [...blueprint.defaultAddOnServiceIds],
    optionalServiceIds: [...blueprint.optionalServiceIds],
    supportedRegions: [...DESIGN_REGIONS],
  }));
}

export function getServiceRegionCapability(serviceId, region) {
  return capabilityForRegion(getServiceDefinition(serviceId).capabilityMatrix, region);
}

export { getServiceDefinition };

export function listServiceCatalog() {
  return listServiceDefinitions().map((service) => ({
    ...service,
    supportedRegions: service.capabilityMatrix
      .filter((entry) => entry.support !== "unavailable")
      .map((entry) => entry.region),
  }));
}
