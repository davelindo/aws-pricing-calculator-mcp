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
    defaultOperatingSystem,
    keywords,
    packIds,
    packs: packs.map(({ id: packId, title: packTitle, description: packDescription }) => ({
      id: packId,
      title: packTitle,
      description: packDescription,
    })),
    requiredServiceFamilies,
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
    defaultOperatingSystem: "linux",
    keywords: ["eks", "kubernetes", "ecs", "argocd", "container", "containers"],
    packIds: ["edge", "observability", "storage-data"],
    requiredServiceIds: [
      "amazon-eks",
      "amazon-ec2",
      "amazon-rds-postgresql",
      "amazon-vpc-nat",
    ],
    optionalServiceIds: ["amazon-sqs", "amazon-sns"],
    addOnAllocations: {
      "amazon-sqs": 0.01,
      "amazon-sns": 0.01,
    },
    requiredServiceFamilies: ["compute", "database", "networking"],
  }),
  "linux-web-stack": composeBlueprint({
    id: "linux-web-stack",
    title: "Linux Web Stack",
    description:
      "Three-environment Linux application stack with EC2, PostgreSQL, and shared networking plus web-edge services.",
    templateId: "linux-heavy",
    defaultOperatingSystem: "linux",
    keywords: ["linux", "web", "app", "fleet", "ec2"],
    packIds: ["edge", "observability", "storage-data"],
    requiredServiceIds: [
      "amazon-ec2",
      "amazon-rds-postgresql",
      "amazon-vpc-nat",
    ],
    optionalServiceIds: ["amazon-api-gateway-http"],
    addOnAllocations: {
      "application-load-balancer": 0.05,
      "amazon-s3": 0.025,
      "amazon-api-gateway-http": 0.02,
    },
    requiredServiceFamilies: ["compute", "database", "networking"],
  }),
  "windows-app-stack": composeBlueprint({
    id: "windows-app-stack",
    title: "Windows Application Stack",
    description:
      "Three-environment Windows-heavy application stack with EC2, PostgreSQL baseline data, and shared networking.",
    templateId: "windows-heavy",
    defaultOperatingSystem: "windows",
    keywords: ["windows", "microsoft", "active directory", "iis"],
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
  }),
  "edge-api-platform": composeBlueprint({
    id: "edge-api-platform",
    title: "Edge API Platform",
    description:
      "API-first platform with edge delivery, serverless components, managed data, and core VPC services.",
    templateId: "linux-heavy",
    defaultOperatingSystem: "linux",
    keywords: ["api", "edge", "cloudfront", "lambda", "serverless"],
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
  }),
  "event-driven-platform": composeBlueprint({
    id: "event-driven-platform",
    title: "Event-Driven Platform",
    description:
      "Application stack with asynchronous messaging, Lambda workers, and managed data services.",
    templateId: "linux-heavy",
    defaultOperatingSystem: "linux",
    keywords: ["event-driven", "sqs", "sns", "eventbridge", "queue", "async"],
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
  }),
  "data-platform-lite": composeBlueprint({
    id: "data-platform-lite",
    title: "Data Platform Lite",
    description:
      "Lightweight data-oriented platform with storage, operational analytics signals, and managed databases.",
    templateId: "data-platform-standard",
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
  }),
  "modernization-platform": composeBlueprint({
    id: "modernization-platform",
    title: "Modernization Platform",
    description:
      "Modernization-oriented application platform with ECS/Fargate, managed networking, and shared platform services.",
    templateId: "linux-heavy",
    defaultOperatingSystem: "linux",
    keywords: ["modernization", "migration", "fargate", "ecs", "refactor"],
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
  }),
  "enterprise-data-platform": composeBlueprint({
    id: "enterprise-data-platform",
    title: "Enterprise Data Platform",
    description:
      "Enterprise-oriented data platform with Aurora-class databases, analytics services, and private networking options.",
    templateId: "enterprise-data-standard",
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
  }),
  "enterprise-data-lake": composeBlueprint({
    id: "enterprise-data-lake",
    title: "Enterprise Data Lake",
    description:
      "Shared data lake architecture with S3, Athena, Redshift Serverless, and Glue-driven ingestion/catalog services.",
    templateId: "enterprise-data-lake-standard",
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
  }),
};

export function supportedTemplateIds() {
  return Object.keys(TEMPLATE_METADATA);
}

export function supportedBlueprintIds() {
  return Object.keys(BLUEPRINTS);
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

export function resolveBlueprintIdForTemplate(templateId) {
  return getTemplate(templateId).blueprintId;
}

export function listBlueprintCatalog() {
  return Object.values(BLUEPRINTS).map((blueprint) => ({
    id: blueprint.id,
    title: blueprint.title,
    description: blueprint.description,
    defaultOperatingSystem: blueprint.defaultOperatingSystem,
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
