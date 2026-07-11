import { listServiceDefinitions } from "../services/index.js";

// These hints complement the calculator catalog. They intentionally describe identifiers,
// not architecture defaults: recognizing one resource must never pull in adjacent services.
const SERVICE_HINTS = {
  "amazon-eks": {
    aliases: ["elastic kubernetes service", "managed kubernetes"],
    capabilities: ["kubernetes cluster", "managed kubernetes cluster"],
    cloudFormation: ["AWS::EKS::Cluster", "AWS::EKS::Nodegroup"],
    terraform: ["aws_eks_cluster", "aws_eks_node_group", "aws_eks_fargate_profile"],
  },
  "amazon-ec2": {
    aliases: ["elastic compute cloud", "ec2 instance", "ec2 instances"],
    capabilities: ["virtual machine", "virtual machines", "compute instance", "compute fleet"],
    cloudFormation: [
      "AWS::EC2::Instance",
      "AWS::EC2::LaunchTemplate",
      "AWS::AutoScaling::AutoScalingGroup",
    ],
    terraform: ["aws_instance", "aws_launch_template", "aws_autoscaling_group"],
  },
  "amazon-athena": {
    aliases: ["aws athena"],
    capabilities: ["serverless sql query", "query data in s3", "batch query"],
    cloudFormation: ["AWS::Athena::WorkGroup", "AWS::Athena::DataCatalog"],
    terraform: ["aws_athena_workgroup", "aws_athena_database", "aws_athena_data_catalog"],
  },
  "amazon-bedrock": {
    aliases: [
      "aws bedrock",
      "bedrock runtime",
      "amazon bedrock inference",
      "amazon nova lite",
    ],
    capabilities: [
      "foundation model inference",
      "generative ai inference",
      "managed foundation models",
    ],
    cloudFormation: [
      "AWS::Bedrock::Agent",
      "AWS::Bedrock::InferenceProfile",
      "AWS::Bedrock::ModelInvocationJob",
    ],
    terraform: [
      "aws_bedrockagent_agent",
      "aws_bedrock_inference_profile",
      "aws_bedrock_model_invocation_logging_configuration",
    ],
  },
  "amazon-redshift": {
    aliases: ["redshift serverless", "aws redshift"],
    capabilities: ["cloud data warehouse", "serverless data warehouse", "warehouse serving"],
    cloudFormation: [
      "AWS::Redshift::Cluster",
      "AWS::RedshiftServerless::Namespace",
      "AWS::RedshiftServerless::Workgroup",
    ],
    terraform: [
      "aws_redshift_cluster",
      "aws_redshiftserverless_namespace",
      "aws_redshiftserverless_workgroup",
    ],
  },
  "aws-glue-etl": {
    aliases: ["glue job", "glue jobs"],
    capabilities: ["managed etl", "batch transforms", "data preparation"],
    cloudFormation: ["AWS::Glue::Job", "AWS::Glue::Workflow", "AWS::Glue::Trigger"],
    terraform: ["aws_glue_job", "aws_glue_workflow", "aws_glue_trigger"],
  },
  "aws-glue-data-catalog": {
    aliases: ["glue database", "glue table"],
    capabilities: ["metadata catalog", "data catalog"],
    cloudFormation: [
      "AWS::Glue::Database",
      "AWS::Glue::Table",
      "AWS::Glue::Registry",
      "AWS::Glue::Schema",
    ],
    terraform: [
      "aws_glue_catalog_database",
      "aws_glue_catalog_table",
      "aws_glue_registry",
      "aws_glue_schema",
    ],
  },
  "aws-glue-crawlers": {
    aliases: ["glue crawler", "glue crawlers"],
    capabilities: ["schema crawler", "data crawler", "catalog crawler"],
    cloudFormation: ["AWS::Glue::Crawler"],
    terraform: ["aws_glue_crawler"],
  },
  "amazon-kinesis-firehose": {
    aliases: ["amazon data firehose", "kinesis data firehose", "data firehose"],
    capabilities: ["delivery stream", "stream ingestion", "stream delivery"],
    cloudFormation: ["AWS::KinesisFirehose::DeliveryStream"],
    terraform: ["aws_kinesis_firehose_delivery_stream"],
  },
  "amazon-rds-postgresql": {
    aliases: ["rds postgres", "rds postgresql", "postgres rds", "postgresql rds"],
    capabilities: ["managed postgres", "managed postgresql", "postgres database"],
    cloudFormation: [
      "AWS::Bedrock::Agent",
      "AWS::Bedrock::InferenceProfile",
      "AWS::Bedrock::ModelInvocationJob",
    ],
    terraform: [
      "aws_bedrockagent_agent",
      "aws_bedrock_inference_profile",
      "aws_bedrock_model_invocation_logging_configuration",
    ],
  },
  "amazon-rds-mysql": {
    aliases: ["rds mysql", "mysql rds"],
    capabilities: ["managed mysql", "mysql database"],
    cloudFormation: [],
    terraform: [],
  },
  "amazon-rds-sqlserver": {
    aliases: ["rds sql server", "sql server rds", "rds mssql"],
    capabilities: ["managed sql server", "microsoft sql server database"],
    cloudFormation: [],
    terraform: [],
  },
  "amazon-aurora-postgresql": {
    aliases: ["aurora postgres", "aurora postgresql", "aurora postgresql compatible"],
    capabilities: ["aurora postgres database", "aurora postgresql database"],
    cloudFormation: [],
    terraform: [],
  },
  "amazon-aurora-mysql": {
    aliases: ["aurora mysql", "aurora mysql compatible"],
    capabilities: ["aurora mysql database"],
    cloudFormation: [],
    terraform: [],
  },
  "amazon-elasticache-redis": {
    aliases: ["elasticache redis", "amazon elasticache", "elasticache for redis"],
    capabilities: ["managed redis", "redis cache", "in-memory cache"],
    cloudFormation: ["AWS::ElastiCache::CacheCluster", "AWS::ElastiCache::ReplicationGroup"],
    terraform: ["aws_elasticache_cluster", "aws_elasticache_replication_group"],
  },
  "amazon-vpc-nat": {
    aliases: ["nat gateway", "vpc nat gateway", "aws nat gateway"],
    capabilities: ["outbound internet gateway", "private subnet egress", "network address translation"],
    cloudFormation: ["AWS::EC2::NatGateway"],
    terraform: ["aws_nat_gateway"],
  },
  "application-load-balancer": {
    aliases: ["application load balancer", "elastic load balancing application load balancer"],
    capabilities: ["layer 7 load balancer", "http load balancer", "https load balancer"],
    cloudFormation: [],
    terraform: ["aws_alb"],
  },
  "network-load-balancer": {
    aliases: ["network load balancer"],
    capabilities: ["layer 4 load balancer", "tcp load balancer", "udp load balancer"],
    cloudFormation: [],
    terraform: ["aws_nlb"],
  },
  "amazon-s3": {
    aliases: ["simple storage service", "s3 bucket", "s3 buckets"],
    capabilities: ["object storage", "object store", "static asset bucket"],
    cloudFormation: ["AWS::S3::Bucket", "AWS::S3::AccessPoint"],
    terraform: ["aws_s3_bucket", "aws_s3_access_point"],
  },
  "amazon-efs": {
    aliases: ["elastic file system", "efs file system"],
    capabilities: ["shared file system", "managed nfs", "nfs file system"],
    cloudFormation: ["AWS::EFS::FileSystem"],
    terraform: ["aws_efs_file_system"],
  },
  "amazon-ebs": {
    aliases: ["elastic block store", "ebs volume", "ebs volumes"],
    capabilities: ["block storage", "block volume"],
    cloudFormation: ["AWS::EC2::Volume"],
    terraform: ["aws_ebs_volume"],
  },
  "amazon-ecs-ec2": {
    aliases: ["ecs on ec2", "ec2 launch type", "ecs ec2"],
    capabilities: ["ec2 backed containers", "container hosts"],
    cloudFormation: [],
    terraform: [],
  },
  "amazon-cloudfront": {
    aliases: ["aws cloudfront", "cloudfront distribution"],
    capabilities: ["content delivery network", "content distribution network", "edge distribution"],
    cloudFormation: ["AWS::CloudFront::Distribution"],
    terraform: ["aws_cloudfront_distribution"],
  },
  "amazon-lambda": {
    aliases: ["aws lambda", "lambda function", "lambda functions"],
    capabilities: ["serverless function", "serverless functions", "function as a service"],
    cloudFormation: ["AWS::Lambda::Function"],
    terraform: ["aws_lambda_function"],
  },
  "amazon-dynamodb": {
    aliases: ["aws dynamodb", "dynamodb table"],
    capabilities: ["managed nosql database", "key value database", "serverless nosql"],
    cloudFormation: ["AWS::DynamoDB::Table", "AWS::DAX::Cluster"],
    terraform: ["aws_dynamodb_table", "aws_dax_cluster"],
  },
  "amazon-api-gateway-http": {
    aliases: ["amazon api gateway", "aws api gateway", "api gateway http api"],
    capabilities: ["http api gateway", "rest api gateway", "managed api gateway"],
    cloudFormation: ["AWS::ApiGateway::RestApi", "AWS::ApiGatewayV2::Api"],
    terraform: ["aws_api_gateway_rest_api", "aws_apigatewayv2_api"],
  },
  "amazon-route53": {
    aliases: ["amazon route 53", "aws route 53", "route 53"],
    capabilities: ["managed dns", "dns hosted zone"],
    cloudFormation: ["AWS::Route53::HostedZone", "AWS::Route53::RecordSet"],
    terraform: ["aws_route53_zone", "aws_route53_record"],
  },
  "amazon-sqs": {
    aliases: ["simple queue service", "sqs queue"],
    capabilities: ["message queue", "managed queue", "dead letter queue"],
    cloudFormation: ["AWS::SQS::Queue"],
    terraform: ["aws_sqs_queue"],
  },
  "amazon-sns": {
    aliases: ["simple notification service", "sns topic"],
    capabilities: ["notification topic", "publish subscribe", "pub sub topic"],
    cloudFormation: ["AWS::SNS::Topic"],
    terraform: ["aws_sns_topic"],
  },
  "amazon-cloudwatch": {
    aliases: ["aws cloudwatch", "cloudwatch logs"],
    capabilities: ["aws monitoring", "central logging", "metrics and alarms"],
    cloudFormation: ["AWS::CloudWatch::Alarm", "AWS::Logs::LogGroup", "AWS::Logs::MetricFilter"],
    terraform: ["aws_cloudwatch_log_group", "aws_cloudwatch_metric_alarm", "aws_cloudwatch_log_metric_filter"],
  },
  "amazon-eventbridge": {
    aliases: ["amazon eventbridge", "aws eventbridge", "cloudwatch events"],
    capabilities: ["event bus", "event router", "event routing"],
    cloudFormation: ["AWS::Events::EventBus", "AWS::Events::Rule", "AWS::Scheduler::Schedule"],
    terraform: ["aws_cloudwatch_event_bus", "aws_cloudwatch_event_rule", "aws_scheduler_schedule"],
  },
  "aws-waf-v2": {
    aliases: ["aws waf", "waf v2", "web application firewall"],
    capabilities: ["web application firewall", "web acl"],
    cloudFormation: ["AWS::WAFv2::WebACL", "AWS::WAFv2::RuleGroup"],
    terraform: ["aws_wafv2_web_acl", "aws_wafv2_rule_group"],
  },
  "amazon-fsx-windows": {
    aliases: ["fsx for windows", "amazon fsx for windows", "windows file server"],
    capabilities: ["windows file share", "managed smb", "smb file system"],
    cloudFormation: ["AWS::FSx::FileSystem"],
    terraform: ["aws_fsx_windows_file_system"],
  },
  "amazon-opensearch": {
    aliases: ["amazon opensearch service", "aws opensearch", "amazon elasticsearch service"],
    capabilities: ["managed search cluster", "log search", "search and analytics"],
    cloudFormation: ["AWS::OpenSearchService::Domain", "AWS::Elasticsearch::Domain"],
    terraform: ["aws_opensearch_domain", "aws_elasticsearch_domain"],
  },
  "amazon-vpc-endpoints": {
    aliases: ["vpc endpoint", "vpc endpoints", "aws privatelink"],
    capabilities: ["private service endpoint", "private endpoint", "interface endpoint"],
    cloudFormation: ["AWS::EC2::VPCEndpoint", "AWS::EC2::VPCEndpointService"],
    terraform: ["aws_vpc_endpoint", "aws_vpc_endpoint_service"],
  },
  "amazon-ecs-fargate": {
    aliases: ["ecs fargate", "aws fargate", "amazon fargate", "fargate launch type"],
    capabilities: ["serverless containers", "managed container tasks"],
    cloudFormation: ["AWS::ECS::TaskDefinition"],
    terraform: [],
  },
};

const AMBIGUOUS_IDENTIFIERS = new Map([
  ["rds", ["amazon-rds-postgresql", "amazon-rds-mysql", "amazon-rds-sqlserver"]],
  ["relational database service", ["amazon-rds-postgresql", "amazon-rds-mysql", "amazon-rds-sqlserver"]],
  ["aurora", ["amazon-aurora-postgresql", "amazon-aurora-mysql"]],
  ["ecs", ["amazon-ecs-ec2", "amazon-ecs-fargate"]],
  ["elastic container service", ["amazon-ecs-ec2", "amazon-ecs-fargate"]],
]);

const UNSAFE_GENERIC_KEYWORDS = new Set([
  "app",
  "edge",
  "endpoint",
  "fleet",
  "function",
  "instance",
  "linux",
  "logging",
  "monitoring",
  "network",
  "search",
  "topic",
  "windows",
]);
const UNSAFE_DYNAMIC_ALIASES = new Set(["amazon", "aws"]);

function normalizeIdentifier(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_:/.-]+/g, " ")
    .replace(/\s+/g, " ");
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function aliasValue(value) {
  return typeof value === "object" ? value?.value : value;
}

function createServiceEntry(service) {
  const configuredHints = SERVICE_HINTS[service.id] ?? {};
  const suppliedHints = service.hints ?? {};
  const hints = {
    aliases: [
      ...(configuredHints.aliases ?? []),
      ...(suppliedHints.aliases ?? []),
      ...(service.aliases ?? []),
    ].map(aliasValue),
    capabilities: [
      ...(configuredHints.capabilities ?? []),
      ...(suppliedHints.capabilities ?? []),
      ...(service.capabilities ?? []),
    ].map(aliasValue),
    cloudFormation: [
      ...(configuredHints.cloudFormation ?? []),
      ...(suppliedHints.cloudFormation ?? []),
    ].map(aliasValue),
    terraform: [
      ...(configuredHints.terraform ?? []),
      ...(suppliedHints.terraform ?? []),
    ].map(aliasValue),
  };
  const aliases = [
    { value: service.id, method: "canonical-id", confidence: 1, priority: 100 },
    { value: service.name, method: "canonical-name", confidence: 1, priority: 95 },
    ...(service.calculatorServiceCodes ?? []).map((value) => ({
      value,
      method: "calculator-service-code",
      confidence: 1,
      priority: 92,
    })),
    ...(hints.aliases ?? []).map((value) => ({
      value,
      method: "common-alias",
      confidence: 0.96,
      priority: 88,
    })),
    ...(service.keywords ?? [])
      .filter((value) => !UNSAFE_GENERIC_KEYWORDS.has(normalizeIdentifier(value)))
      .filter((value) => !AMBIGUOUS_IDENTIFIERS.has(normalizeIdentifier(value)))
      .map((value) => ({
        value,
        method: "catalog-keyword",
        confidence: 0.9,
        priority: 75,
      })),
    ...(hints.capabilities ?? []).map((value) => ({
      value,
      method: "capability-phrase",
      confidence: 0.78,
      priority: 60,
    })),
    ...(hints.cloudFormation ?? []).map((value) => ({
      value,
      method: "cloudformation-type",
      confidence: 1,
      priority: 98,
    })),
    ...(hints.terraform ?? []).map((value) => ({
      value,
      method: "terraform-type",
      confidence: 1,
      priority: 98,
    })),
  ];

  const seen = new Set();
  return {
    ...service,
    hints,
    aliases: aliases.filter(({ value }) => {
      const key = normalizeIdentifier(value);
      if (
        !key ||
        seen.has(key) ||
        (service.implementationStatus === "dynamic" && UNSAFE_DYNAMIC_ALIASES.has(key))
      ) {
        return false;
      }
      seen.add(key);
      return true;
    }),
  };
}

const catalog = listServiceDefinitions();
const staticServiceIds = new Set(catalog.map((service) => service.id));
const dynamicServiceIds = new Set();
const serviceById = new Map(catalog.map((service) => [service.id, service]));
const entries = catalog.map(createServiceEntry);

const cloudFormationMap = new Map();
const terraformMap = new Map();

function rebuildInfrastructureMaps() {
  cloudFormationMap.clear();
  terraformMap.clear();

  for (const entry of entries) {
    for (const type of entry.hints.cloudFormation ?? []) {
      cloudFormationMap.set(type.toLowerCase(), entry.id);
    }
    for (const type of entry.hints.terraform ?? []) {
      terraformMap.set(type.toLowerCase(), entry.id);
    }
  }
}

rebuildInfrastructureMaps();

export function registerDynamicUniversalServices(services, { replace = true } = {}) {
  if (replace && dynamicServiceIds.size > 0) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (dynamicServiceIds.has(entries[index].id)) {
        entries.splice(index, 1);
      }
    }
    for (const serviceId of dynamicServiceIds) {
      serviceById.delete(serviceId);
    }
    dynamicServiceIds.clear();
  }

  for (const service of services ?? []) {
    const id = String(service?.id ?? service?.canonicalServiceId ?? "").trim();

    if (!id || staticServiceIds.has(id) || serviceById.has(id)) {
      continue;
    }

    const descriptor = {
      ...service,
      id,
      name: service.name ?? id,
      category: service.category ?? "aws-calculator",
      implementationStatus: service.implementationStatus ?? "dynamic",
      capabilityMatrix: service.capabilityMatrix ?? [],
      keywords: service.keywords ?? [],
      pricingStrategies: service.pricingStrategies ?? [],
      calculatorServiceCodes: service.calculatorServiceCodes ??
        (service.serviceCode ? [service.serviceCode] : []),
      universalPricingMode: service.universalPricingMode ?? "dynamic",
    };

    serviceById.set(id, descriptor);
    entries.push(createServiceEntry(descriptor));
    dynamicServiceIds.add(id);
  }

  rebuildInfrastructureMaps();
  return dynamicServiceIds.size;
}

export function listUniversalServiceEntries() {
  return entries;
}

export function universalServiceById(serviceId) {
  return serviceById.get(serviceId) ?? null;
}

export function serviceIdForCloudFormationType(type) {
  const rawType = String(type ?? "");
  const exact = cloudFormationMap.get(rawType.toLowerCase());

  if (exact) return exact;

  const namespace = rawType.match(/^AWS::([^:]+)::/i)?.[1];
  if (!namespace) return null;
  const compactNamespace = normalizeIdentifier(namespace).replaceAll(" ", "");
  const matches = entries.filter((entry) =>
    entry.aliases.some(
      (alias) =>
        normalizeIdentifier(alias.value).replaceAll(" ", "") === compactNamespace,
    ),
  );

  return matches.length === 1 ? matches[0].id : null;
}

export function serviceIdForTerraformType(type) {
  return terraformMap.get(String(type ?? "").toLowerCase()) ?? null;
}

export function ambiguousCandidates(identifier) {
  return AMBIGUOUS_IDENTIFIERS.get(normalizeIdentifier(identifier)) ?? null;
}

export function ambiguousIdentifiers() {
  return [...AMBIGUOUS_IDENTIFIERS.entries()].map(([value, candidates]) => ({
    value,
    candidates: [...candidates],
  }));
}

export function knownCloudFormationTypes() {
  return dedupe([...cloudFormationMap.keys()]);
}

export function knownTerraformTypes() {
  return dedupe([...terraformMap.keys()]);
}

export { normalizeIdentifier };
