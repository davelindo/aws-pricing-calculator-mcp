import { amazonEc2Service } from "./amazon-ec2.js";
import { amazonEksService } from "./amazon-eks.js";
import { amazonRdsPostgresqlService } from "./amazon-rds-postgresql.js";
import { amazonAthenaService } from "./amazon-athena.js";
import { amazonApiGatewayHttpService } from "./amazon-api-gateway-http.js";
import { amazonAuroraMysqlService } from "./amazon-aurora-mysql.js";
import { amazonAuroraPostgresqlService } from "./amazon-aurora-postgresql.js";
import { amazonCloudfrontService } from "./amazon-cloudfront.js";
import { amazonCloudwatchService } from "./amazon-cloudwatch.js";
import { amazonDynamodbService } from "./amazon-dynamodb.js";
import { amazonEbsService } from "./amazon-ebs.js";
import { amazonEcsEc2Service, isEcsEc2SavedService } from "./amazon-ecs-ec2.js";
import { amazonEcsFargateService } from "./amazon-ecs-fargate.js";
import { amazonEfsService } from "./amazon-efs.js";
import { amazonElasticacheRedisService } from "./amazon-elasticache-redis.js";
import { amazonLambdaService } from "./amazon-lambda.js";
import { amazonEventbridgeService } from "./amazon-eventbridge.js";
import { amazonFsxWindowsService } from "./amazon-fsx-windows.js";
import { amazonKinesisFirehoseService } from "./amazon-kinesis-firehose.js";
import { amazonOpensearchService } from "./amazon-opensearch.js";
import { amazonRedshiftService } from "./amazon-redshift.js";
import { amazonRdsMysqlService } from "./amazon-rds-mysql.js";
import { amazonRoute53Service } from "./amazon-route53.js";
import { amazonRdsSqlserverService } from "./amazon-rds-sqlserver.js";
import { amazonS3Service } from "./amazon-s3.js";
import { amazonSnsService } from "./amazon-sns.js";
import { amazonSqsService } from "./amazon-sqs.js";
import { amazonVpcEndpointsService } from "./amazon-vpc-endpoints.js";
import { amazonVpcNatService } from "./amazon-vpc-nat.js";
import { awsGlueCrawlersService } from "./aws-glue-crawlers.js";
import { awsGlueDataCatalogService } from "./aws-glue-data-catalog.js";
import { awsGlueEtlService } from "./aws-glue-etl.js";
import { awsWafV2Service } from "./aws-waf-v2.js";
import { applicationLoadBalancerService } from "./application-load-balancer.js";
import { networkLoadBalancerService } from "./network-load-balancer.js";
import {
  TARGET_REGIONS,
  SUPPORT_STATES,
  capabilityForRegion,
} from "./helpers.js";

const SERVICE_DEFINITIONS = [
  amazonEksService,
  amazonEc2Service,
  amazonAthenaService,
  amazonRedshiftService,
  awsGlueEtlService,
  awsGlueDataCatalogService,
  awsGlueCrawlersService,
  amazonKinesisFirehoseService,
  amazonRdsPostgresqlService,
  amazonRdsMysqlService,
  amazonRdsSqlserverService,
  amazonAuroraPostgresqlService,
  amazonAuroraMysqlService,
  amazonElasticacheRedisService,
  amazonVpcNatService,
  applicationLoadBalancerService,
  networkLoadBalancerService,
  amazonS3Service,
  amazonEfsService,
  amazonEbsService,
  amazonEcsEc2Service,
  amazonCloudfrontService,
  amazonLambdaService,
  amazonDynamodbService,
  amazonApiGatewayHttpService,
  amazonRoute53Service,
  amazonSqsService,
  amazonSnsService,
  amazonCloudwatchService,
  amazonEventbridgeService,
  awsWafV2Service,
  amazonFsxWindowsService,
  amazonOpensearchService,
  amazonVpcEndpointsService,
  amazonEcsFargateService,
];
const SERVICE_DEFINITION_MAP = new Map(
  SERVICE_DEFINITIONS.map((service) => [service.id, service]),
);

export { TARGET_REGIONS, SUPPORT_STATES, capabilityForRegion };

const SERVICE_CODE_MAP = new Map();

for (const service of SERVICE_DEFINITIONS) {
  for (const serviceCode of service.calculatorServiceCodes) {
    if (!SERVICE_CODE_MAP.has(serviceCode)) {
      SERVICE_CODE_MAP.set(serviceCode, service);
    }
  }
}

export function getServiceDefinition(serviceId) {
  const definition = SERVICE_DEFINITION_MAP.get(serviceId);

  if (!definition) {
    throw new Error(`Unknown service '${serviceId}'.`);
  }

  return definition;
}

export function findServiceDefinitionByCalculatorServiceCode(serviceCode) {
  return SERVICE_CODE_MAP.get(serviceCode) ?? null;
}

export function resolveServiceDefinitionForSavedService(service) {
  if (!service?.serviceCode) {
    return null;
  }

  if (service.serviceCode === "ec2Enhancement") {
    return isEcsEc2SavedService(service)
      ? getServiceDefinition("amazon-ecs-ec2")
      : getServiceDefinition("amazon-ec2");
  }

  return findServiceDefinitionByCalculatorServiceCode(service.serviceCode);
}

export function listServiceDefinitions() {
  return SERVICE_DEFINITIONS.map((service) => ({
    id: service.id,
    name: service.name,
    category: service.category,
    implementationStatus: service.implementationStatus,
    capabilityMatrix: service.capabilityMatrix.map((entry) => ({ ...entry })),
    keywords: [...service.keywords],
    pricingStrategies: [...service.pricingStrategies],
    calculatorServiceCodes: [...service.calculatorServiceCodes],
  }));
}
