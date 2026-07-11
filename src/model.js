import crypto from "node:crypto";

const HOURS_PER_MONTH = 730;
const REGION_NAMES = {
  "us-east-1": "US East (N. Virginia)",
  "ca-central-1": "Canada (Central)",
  "sa-east-1": "South America (Sao Paulo)",
  "eu-west-1": "Europe (Ireland)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
};

const REGION_PRICE_MULTIPLIERS = {
  "us-east-1": 1,
  "ca-central-1": 1.09,
  "sa-east-1": 1.32,
  "eu-west-1": 1.11,
  "ap-southeast-2": 1.18,
  "ap-northeast-2": 1.16,
};

function deepScalePricing(value, multiplier) {
  if (typeof value === "number") {
    return Math.round((value * multiplier + Number.EPSILON) * 1_000_000_000_000) / 1_000_000_000_000;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => deepScalePricing(entry, multiplier));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, deepScalePricing(entry, multiplier)]),
    );
  }

  return value;
}

const PRICING = {
  "us-east-1": {
    eks: {
      standardControlPlaneHourly: 0.1,
    },
    ec2: {
      linux: {
        "m6i.large": 0.096,
        "m6i.xlarge": 0.192,
        "m6i.2xlarge": 0.384,
      },
      windows: {
        "m6i.large": 0.188,
        "m6i.xlarge": 0.376,
        "m6i.2xlarge": 0.752,
      },
    },
    rdsPostgres: {
      instanceHourly: {
        "db.t4g.large": {
          "Single-AZ": 0.129,
          "Multi-AZ": 0.258,
        },
        "db.r6g.large": {
          "Single-AZ": 0.225,
          "Multi-AZ": 0.45,
        },
        "db.r6g.xlarge": {
          "Single-AZ": 0.45,
          "Multi-AZ": 0.899,
        },
        "db.r6g.2xlarge": {
          "Single-AZ": 0.899,
          "Multi-AZ": 1.798,
        },
        "db.r6g.4xlarge": {
          "Multi-AZ": 3.597,
        },
      },
      storagePerGbMonth: {
        "Single-AZ": 0.115,
        "Multi-AZ": 0.23,
      },
    },
    natGateway: {
      hourly: 0.045,
      regionalHourly: 0.045,
      dataPerGb: 0.045,
    },
  },
};

const EC2_PRICING_STRATEGY_MULTIPLIERS = {
  "on-demand": 1,
  "savings-plans": 0.86,
  "reserved": 0.82,
  "reserved-heavy": 0.76,
  spot: 0.58,
};

const RDS_PRICING_MODEL_MULTIPLIERS = {
  OnDemand: 1,
  Reserved: 0.9,
  ReservedHeavy: 0.84,
};

const SERVICE_ROLE_METADATA = {
  eks: {
    kind: "eks",
    label: "Amazon EKS Control Plane",
    category: "compute",
    supportive: false,
  },
  ec2Linux: {
    kind: "ec2Linux",
    label: "Amazon EC2 Linux",
    category: "compute",
    supportive: false,
  },
  ec2Windows: {
    kind: "ec2Windows",
    label: "Amazon EC2 Windows",
    category: "compute",
    supportive: false,
  },
  rdsPostgres: {
    kind: "rdsPostgres",
    label: "Amazon RDS for PostgreSQL",
    category: "database",
    supportive: false,
  },
  vpcNat: {
    kind: "vpcNat",
    label: "Amazon VPC / NAT",
    category: "supportive",
    supportive: true,
  },
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function roundCurrency(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function parseNumericValue(value, fallback = 0) {
  if (value == null || value === "") {
    return fallback;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function regionNameFor(region) {
  return REGION_NAMES[region] ?? region;
}

export function pricingFor(region) {
  const pricing = PRICING[region];

  if (!pricing) {
    const basePricing = PRICING["us-east-1"];
    const multiplier = REGION_PRICE_MULTIPLIERS[region];

    if (!basePricing || !multiplier) {
      throw new Error(
        `Unsupported region '${region}'. Supported regions: ${Object.keys(REGION_PRICE_MULTIPLIERS).join(", ")}.`,
      );
    }

    return deepScalePricing(basePricing, multiplier);
  }

  return pricing;
}

function monthlyFromHourly(hourlyRate) {
  return roundCurrency(hourlyRate * HOURS_PER_MONTH);
}

function randomServiceKey(serviceCode, environment) {
  return `${serviceCode}-${environment}-${crypto.randomUUID()}`;
}

export function modelEksMonthlyUsd(region, clusterCount) {
  return roundCurrency(
    clusterCount * monthlyFromHourly(pricingFor(region).eks.standardControlPlaneHourly),
  );
}

function ec2MonthlyRate(region, operatingSystem, instanceType) {
  const hourly = pricingFor(region).ec2[operatingSystem]?.[instanceType];

  if (!hourly) {
    throw new Error(
      `Unsupported ${operatingSystem} EC2 instance '${instanceType}' in region '${region}'.`,
    );
  }

  return monthlyFromHourly(hourly);
}

export function modelEc2MonthlyUsd(region, operatingSystem, instanceType, instanceCount) {
  return roundCurrency(ec2MonthlyRate(region, operatingSystem, instanceType) * instanceCount);
}

export function ec2PricingStrategyMultiplier(selectedOption) {
  return EC2_PRICING_STRATEGY_MULTIPLIERS[selectedOption] ?? 1;
}

function rdsInstanceHourlyRate(region, instanceType, deploymentOption) {
  const hourly = pricingFor(region).rdsPostgres.instanceHourly[instanceType]?.[deploymentOption];

  if (!hourly) {
    throw new Error(
      `Unsupported RDS PostgreSQL instance '${instanceType}' with deployment '${deploymentOption}' in region '${region}'.`,
    );
  }

  return hourly;
}

function rdsStorageMonthlyRate(region, deploymentOption) {
  const rate = pricingFor(region).rdsPostgres.storagePerGbMonth[deploymentOption];

  if (!rate) {
    throw new Error(
      `Unsupported RDS PostgreSQL storage deployment '${deploymentOption}' in region '${region}'.`,
    );
  }

  return rate;
}

export function modelRdsMonthlyUsd(region, instanceType, deploymentOption, storageGb, nodeCount = 1) {
  const instanceMonthly = monthlyFromHourly(rdsInstanceHourlyRate(region, instanceType, deploymentOption));
  const storageMonthly = roundCurrency(rdsStorageMonthlyRate(region, deploymentOption) * storageGb);
  return roundCurrency(instanceMonthly * nodeCount + storageMonthly);
}

export function rdsPricingModelMultiplier(termType) {
  return RDS_PRICING_MODEL_MULTIPLIERS[termType] ?? 1;
}

export function modelNatMonthlyUsd(
  region,
  regionalNatGatewayCount,
  regionalNatGatewayAzCount,
  dataProcessedGb,
) {
  const pricing = pricingFor(region);
  const regionalBase = monthlyFromHourly(pricing.natGateway.regionalHourly) * regionalNatGatewayCount;
  const azBase = monthlyFromHourly(pricing.natGateway.hourly) * regionalNatGatewayAzCount;
  const dataMonthly = pricing.natGateway.dataPerGb * dataProcessedGb;
  return roundCurrency(regionalBase + azBase + dataMonthly);
}

function buildDescription(prefix, environment, details, notes) {
  const parts = [prefix, `Environment: ${environment}.`, details];

  if (notes) {
    parts.push(notes);
  }

  return parts.join(" ");
}

export function buildEksService(environment, region, notes) {
  const monthlyUsd = modelEksMonthlyUsd(region, 1);

  return {
    key: randomServiceKey("awsEks", environment),
    breakdown: {
      ...SERVICE_ROLE_METADATA.eks,
      region,
      environment,
      monthlyUsd,
    },
    service: {
      calculationComponents: {
        numberOfEKSClusters: {
          value: "1",
        },
        numberOfHybridNodes: {
          value: "0",
          unit: "perMonth",
        },
      },
      serviceCode: "awsEks",
      region,
      estimateFor: "Amazon EKS",
      version: "0.0.40",
      description: buildDescription(
        "Amazon EKS control plane baseline.",
        environment,
        "One managed control plane cluster.",
        notes,
      ),
      serviceCost: {
        monthly: monthlyUsd,
      },
      serviceName: "Amazon EKS",
      regionName: regionNameFor(region),
      configSummary: "Number of EKS Clusters (1), Number of hybrid nodes (0 per month)",
    },
  };
}

export function buildEc2Service(
  environment,
  region,
  operatingSystem,
  instanceType,
  instanceCount,
  notes,
  pricingStrategy = {},
) {
  const selectedPricingStrategy = pricingStrategy.selectedOption ?? "on-demand";
  const pricingMultiplier = ec2PricingStrategyMultiplier(selectedPricingStrategy);
  const monthlyUsd = roundCurrency(
    modelEc2MonthlyUsd(region, operatingSystem, instanceType, instanceCount) * pricingMultiplier,
  );
  const osLabel = operatingSystem === "windows" ? "Windows Server" : "Linux";
  const metadata =
    operatingSystem === "windows"
      ? SERVICE_ROLE_METADATA.ec2Windows
      : SERVICE_ROLE_METADATA.ec2Linux;
  const pricingLabel =
    selectedPricingStrategy === "savings-plans"
      ? "Savings Plans"
      : selectedPricingStrategy === "reserved"
        ? "Reserved"
        : selectedPricingStrategy === "reserved-heavy"
          ? "Reserved Heavy"
          : selectedPricingStrategy === "spot"
            ? "Spot"
            : "On-Demand";

  return {
    key: randomServiceKey("ec2Enhancement", environment),
    breakdown: {
      ...metadata,
      region,
      environment,
      monthlyUsd,
    },
    service: {
      calculationComponents: {
        tenancy: {
          value: "shared",
        },
        selectedOS: {
          value: operatingSystem,
        },
        workloadSelection: {
          value: "consistent",
        },
        storageType: {
          value: "Storage General Purpose gp3 GB Mo",
        },
        dataTransferForEC2: {
          value: [
            {
              entryType: "INBOUND",
              value: "",
              unit: "tb_month",
              fromRegion: "",
            },
            {
              entryType: "OUTBOUND",
              value: "",
              unit: "tb_month",
              toRegion: "",
            },
            {
              entryType: "INTRA_REGION",
              value: "",
              unit: "tb_month",
            },
          ],
        },
        workload: {
          value: {
            workloadType: "consistent",
            data: String(instanceCount),
          },
        },
        snapshotFrequency: {
          value: "0",
        },
        detailedMonitoringCheckbox: {
          value: false,
        },
        ec2AdvancedPricingMetrics: {
          value: 1,
        },
        instanceType: {
          value: instanceType,
        },
        pricingStrategy: {
          value: {
            selectedOption: selectedPricingStrategy,
            term: pricingStrategy.term ?? "1 year",
            utilizationValue: String(pricingStrategy.utilizationValue ?? "100"),
            utilizationUnit: "%Utilized/Month",
          },
        },
      },
      serviceCode: "ec2Enhancement",
      region,
      estimateFor: "template",
      version: "0.0.68",
      description: buildDescription(
        `Amazon EC2 ${operatingSystem === "windows" ? "Windows" : "Linux"} worker baseline.`,
        environment,
        `${instanceCount} ${instanceType} instances with ${pricingLabel} pricing.`,
        notes,
      ),
      serviceCost: {
        monthly: monthlyUsd,
        upfront: 0,
      },
      serviceName: "Amazon EC2",
      regionName: regionNameFor(region),
      configSummary: `Tenancy (Shared Instances), Operating system (${osLabel}), Workload (Consistent, Number of instances: ${instanceCount}), Advance EC2 instance (${instanceType}), Pricing strategy (${pricingLabel} Utilization: ${pricingStrategy.utilizationValue ?? "100"} %Utilized/Month), Enable monitoring (disabled), DT Inbound: Not selected (0 TB per month), DT Outbound: Not selected (0 TB per month), DT Intra-Region: (0 TB per month)`,
    },
  };
}

export function buildRdsService(
  environment,
  region,
  instanceType,
  deploymentOption,
  storageGb,
  notes,
  pricingModel = "OnDemand",
) {
  const monthlyUsd = roundCurrency(
    modelRdsMonthlyUsd(region, instanceType, deploymentOption, storageGb) *
      rdsPricingModelMultiplier(pricingModel),
  );
  const pricingLabel =
    pricingModel === "ReservedHeavy"
      ? "Reserved Heavy"
      : pricingModel === "Reserved"
        ? "Reserved"
        : "OnDemand";

  return {
    key: randomServiceKey("amazonRDSPostgreSQLDB", environment),
    breakdown: {
      ...SERVICE_ROLE_METADATA.rdsPostgres,
      region,
      environment,
      monthlyUsd,
    },
    service: {
      calculationComponents: {
        createRDSProxy: {
          value: "0",
        },
        storageAmount: {
          value: String(storageGb),
          unit: "gb|NA",
        },
        storageVolume: {
          value: "General Purpose",
        },
        DatabaseInsightsSelected: {
          value: "0",
        },
        retentionPeriod: {
          value: "0",
        },
        addRDSExtendedSupport: {
          value: "0",
        },
        RDSExtendedSupportYear: {
          value: "year12",
        },
        columnFormIPM: {
          value: [
            {
              "Number of Nodes": {
                value: "1",
              },
              "Instance Type": {
                value: instanceType,
              },
              undefined: {
                value: {
                  unit: "100",
                  selectedId: "%Utilized/Month",
                },
              },
              "Deployment Option": {
                value: deploymentOption,
              },
              TermType: {
                value: pricingModel,
              },
            },
          ],
        },
      },
      serviceCode: "amazonRDSPostgreSQLDB",
      region,
      estimateFor: "rdsForPostgreSQL",
      version: "0.0.107",
      description: buildDescription(
        "Amazon RDS for PostgreSQL baseline.",
        environment,
        `${instanceType} with ${deploymentOption}, ${storageGb} GB of storage, and ${pricingLabel} pricing.`,
        notes,
      ),
      serviceCost: {
        monthly: monthlyUsd,
        upfront: 0,
      },
      serviceName: "Amazon RDS for PostgreSQL",
      regionName: regionNameFor(region),
      configSummary: `Storage amount (${storageGb} GB), Storage volume (General Purpose SSD (gp2)), Nodes (1), Instance Type (${instanceType}), Utilization (${pricingLabel}) (100 %Utilized/Month), Deployment Option (${deploymentOption}), Pricing Model (${pricingModel})`,
    },
  };
}

export function buildNatService(region, natPlan, notes) {
  const monthlyUsd = natPlan.monthlyUsd;

  return {
    key: randomServiceKey("amazonVirtualPrivateCloud", "shared"),
    breakdown: {
      ...SERVICE_ROLE_METADATA.vpcNat,
      region,
      environment: "shared",
      monthlyUsd,
    },
    service: {
      version: "0.0.101",
      serviceCode: "amazonVirtualPrivateCloud",
      estimateFor: "virtualPrivateCloudSubServiceSelector",
      region,
      description: buildDescription(
        "Amazon VPC and NAT baseline.",
        "shared",
        `${natPlan.regionalNatGatewayCount} regional NAT profile, ${natPlan.regionalNatGatewayAzCount} AZ-backed NAT gateways, ${natPlan.dataProcessedGb} GB processed monthly.`,
        notes,
      ),
      subServices: [
        {
          calculationComponents: {
            regionalNatGatewayCount: {
              value: String(natPlan.regionalNatGatewayCount),
            },
            regionalNatGatewayAzCount: {
              value: String(natPlan.regionalNatGatewayAzCount),
            },
            numberOfGateways: {
              value: String(natPlan.regionalNatGatewayCount),
            },
            regionalNatGatewayDataProcessed: {
              value: String(natPlan.dataProcessedGb),
              unit: "gb|month",
            },
          },
          serviceCode: "networkAddressTranslationNatGatewayVpc",
          region,
          estimateFor: "networkAddressTranslationGateway",
          version: "0.0.18",
          description: null,
          serviceCost: {
            monthly: monthlyUsd,
          },
        },
      ],
      serviceCost: {
        monthly: monthlyUsd,
      },
      serviceName: "Amazon Virtual Private Cloud (VPC)",
      regionName: regionNameFor(region),
      configSummary: `Number of Regional NAT Gateways (${natPlan.regionalNatGatewayCount}), Number of Availability Zones Regional NAT Gateways is active in (${natPlan.regionalNatGatewayAzCount}), Number of NAT Gateways (${natPlan.regionalNatGatewayCount})`,
    },
  };
}

export function serviceEntries(services) {
  return Object.values(services);
}

export function serviceMonthlyUsd(service) {
  return roundCurrency(Number(service?.serviceCost?.monthly ?? 0));
}

function sumServiceMonthlyUsd(services) {
  return roundCurrency(
    serviceEntries(services).reduce((sum, service) => sum + serviceMonthlyUsd(service), 0),
  );
}

function buildServices(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.key, cloneJson(entry.service)]));
}

export function buildEstimatePayloadFromEntries({ estimateName, entries }) {
  const services = buildServices(entries);
  const totalMonthlyUsd = sumServiceMonthlyUsd(services);

  return {
    name: estimateName,
    services,
    groups: {},
    groupSubtotal: {
      monthly: totalMonthlyUsd,
      upfront: 0,
    },
    totalCost: {
      monthly: totalMonthlyUsd,
      upfront: 0,
    },
    support: {},
    metaData: {
      locale: "en_US",
      currency: "USD",
      createdOn: new Date().toISOString(),
      source: "calculator-platform",
      estimateId: crypto.randomUUID().replaceAll("-", ""),
    },
  };
}
