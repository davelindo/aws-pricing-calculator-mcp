export const DEFAULT_REGION = "us-east-1";
export const DEFAULT_BUDGET_TOLERANCE_PCT = 0.1;
export const DEFAULT_ENVIRONMENT_SPLIT = {
  dev: 0.2,
  staging: 0.3,
  prod: 0.5,
};

const TEMPLATE_METADATA = {
  "eks-rds-standard": {
    id: "eks-rds-standard",
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
};

const EXPECTED_INPUTS = [
  "targetMonthlyUsd",
  "region",
  "environmentSplit",
  "clientName",
  "estimateName",
  "notes",
];

export function supportedTemplateIds() {
  return Object.keys(TEMPLATE_METADATA);
}

export function supportedRegions() {
  return [DEFAULT_REGION];
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

export function listTemplateCatalog() {
  return Object.values(TEMPLATE_METADATA).map((template) => ({
    id: template.id,
    title: template.title,
    description: template.description,
    defaultRegion: DEFAULT_REGION,
    supportedRegions: supportedRegions(),
    expectedInputs: EXPECTED_INPUTS,
    supportiveInfra: [...template.supportiveInfra],
    requiredServiceCodes: [...template.requiredServiceCodes],
    supportiveServiceCodes: [...template.supportiveServiceCodes],
    primaryMinRatio: template.primaryMinRatio,
    supportiveMaxRatio: template.supportiveMaxRatio,
    defaultEnvironmentSplit: {
      ...DEFAULT_ENVIRONMENT_SPLIT,
    },
  }));
}
