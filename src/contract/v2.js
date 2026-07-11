import * as z from "zod/v4";

export const V2_CONTRACT_VERSION = "v2";
export const V2_TOOL_NAMES = Object.freeze([
  "list_service_catalog",
  "interpret_architecture",
  "price_architecture",
  "generate_calculator_link",
]);

const openRecordSchema = z.record(z.string(), z.unknown());
const confidenceSchema = z.number().min(0).max(1);

export const sourceInputSchema = z
  .looseObject({
    id: z.string().optional(),
    name: z.string().optional(),
    mediaType: z.string().optional(),
    formatHint: z.string().optional(),
    content: z.unknown(),
    metadata: openRecordSchema.optional(),
  })
  .refine((source) => Object.hasOwn(source, "content"), {
    message: "Source content is required.",
    path: ["content"],
  });

export const interpretationContextSchema = z.looseObject({
  name: z.string().optional(),
  notes: z.string().optional(),
  region: z.string().optional(),
  regions: z.array(z.string()).optional(),
  environments: z.array(z.string()).optional(),
  operatingSystem: z.string().optional(),
  currency: z.string().optional(),
  targetMonthlyUsd: z.number().positive().optional(),
  budget: z.unknown().optional(),
  timeHorizon: z.unknown().optional(),
  metadata: openRecordSchema.optional(),
});

export const assumptionsPolicySchema = z.union([
  z.string(),
  z.looseObject({
    mode: z.string().optional(),
    allowDefaults: z.boolean().optional(),
    requireConfirmationFor: z.array(z.string()).optional(),
    maxAssumptions: z.number().int().nonnegative().optional(),
  }),
]);

export const provenanceEvidenceSchema = z.looseObject({
  sourceId: z.string().nullable(),
  locator: z.string().nullable(),
  excerpt: z.string().nullable(),
});

export const provenanceSchema = z.looseObject({
  mode: z.string(),
  sourceIds: z.array(z.string()),
  evidence: z.array(provenanceEvidenceSchema),
  confidence: confidenceSchema,
});

export const sourceDescriptorSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullable(),
  mediaType: z.string().nullable(),
  formatHint: z.string().nullable(),
  locator: z.string().nullable(),
  digest: z.string().nullable(),
});

export const architectureRefSchema = z.looseObject({
  contractVersion: z.literal(V2_CONTRACT_VERSION),
  kind: z.literal("architecture_ref"),
  architectureId: z.string(),
  revision: z.string().nullable(),
  token: z.string(),
});

export const architectureRefInputSchema = z.union([z.string(), architectureRefSchema]);

export const serviceResolutionCandidateSchema = z.looseObject({
  serviceId: z.string(),
  serviceName: z.string().nullable(),
  score: confidenceSchema,
  rationale: z.array(z.string()),
});

export const serviceResolutionSchema = z.looseObject({
  status: z.string(),
  serviceId: z.string().nullable(),
  serviceName: z.string().nullable(),
  confidence: confidenceSchema,
  candidates: z.array(serviceResolutionCandidateSchema),
  rationale: z.array(z.string()),
  provenance: provenanceSchema,
});

export const architectureComponentSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  description: z.string().nullable(),
  serviceId: z.string().nullable(),
  resolution: serviceResolutionSchema.nullable(),
  scopeIds: z.array(z.string()),
  region: z.string().nullable(),
  environment: z.string().nullable(),
  quantity: z.number().positive().nullable(),
  configuration: openRecordSchema,
  usage: openRecordSchema,
  pricingStatus: z.string(),
  properties: openRecordSchema,
  provenance: provenanceSchema,
});

export const architectureRelationshipSchema = z.looseObject({
  id: z.string(),
  fromComponentId: z.string(),
  toComponentId: z.string(),
  type: z.string(),
  description: z.string().nullable(),
  properties: openRecordSchema,
  provenance: provenanceSchema,
});

export const architectureScopeSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  parentScopeId: z.string().nullable(),
  componentIds: z.array(z.string()),
  properties: openRecordSchema,
  provenance: provenanceSchema,
});

export const architectureConstraintSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  statement: z.string(),
  appliesTo: z.array(z.string()),
  value: z.unknown(),
  provenance: provenanceSchema,
});

export const architectureAssumptionSchema = z.looseObject({
  id: z.string(),
  statement: z.string(),
  status: z.string(),
  impact: z.string().nullable(),
  appliesTo: z.array(z.string()),
  provenance: provenanceSchema,
});

export const architectureConflictSchema = z.looseObject({
  id: z.string(),
  description: z.string(),
  severity: z.string(),
  appliesTo: z.array(z.string()),
  provenance: z.array(provenanceSchema),
});

export const architectureUnresolvedSchema = z.looseObject({
  id: z.string(),
  path: z.string(),
  description: z.string(),
  blocking: z.boolean(),
  candidateValues: z.array(z.unknown()),
  provenance: provenanceSchema,
});

export const architectureQuestionSchema = z.looseObject({
  id: z.string(),
  prompt: z.string(),
  blocking: z.boolean(),
  priority: z.string(),
  relatedIds: z.array(z.string()),
  answerHint: z.string().nullable(),
});

export const coverageDimensionSchema = z.looseObject({
  name: z.string(),
  status: z.string(),
  score: confidenceSchema,
  gaps: z.array(z.string()),
});

export const architectureCoverageSchema = z.looseObject({
  status: z.string(),
  score: confidenceSchema,
  componentCount: z.number().int().nonnegative(),
  resolvedComponentCount: z.number().int().nonnegative(),
  relationshipCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  dimensions: z.array(coverageDimensionSchema),
  gaps: z.array(z.string()),
});

export const architectureIRSchema = z.looseObject({
  contractVersion: z.literal(V2_CONTRACT_VERSION),
  kind: z.literal("architecture_ir"),
  architectureId: z.string(),
  architectureRef: architectureRefSchema,
  title: z.string().nullable(),
  summary: z.string().nullable(),
  sources: z.array(sourceDescriptorSchema),
  components: z.array(architectureComponentSchema),
  relationships: z.array(architectureRelationshipSchema),
  scopes: z.array(architectureScopeSchema),
  constraints: z.array(architectureConstraintSchema),
  assumptions: z.array(architectureAssumptionSchema),
  conflicts: z.array(architectureConflictSchema),
  unresolved: z.array(architectureUnresolvedSchema),
  questions: z.array(architectureQuestionSchema),
  coverage: architectureCoverageSchema,
  provenance: provenanceSchema,
});

export const serviceCatalogEntrySchema = z.looseObject({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  category: z.string().nullable(),
  aliases: z.array(z.string()),
  capabilities: z.array(z.string()),
  regions: z.array(z.string()),
  pricingSupport: z.string(),
  calculatorServiceCodes: z.array(z.string()),
  metadata: openRecordSchema,
});

export const listServiceCatalogInputSchema = z.looseObject({
  query: z.string().optional(),
  serviceIds: z.array(z.string()).optional(),
  region: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const listServiceCatalogOutputSchema = z.looseObject({
  catalogVersion: z.string(),
  generatedAt: z.string().nullable(),
  services: z.array(serviceCatalogEntrySchema),
  nextCursor: z.string().nullable(),
});

const architectureInputShape = {
  definition: z.unknown().optional(),
  sources: z.array(sourceInputSchema).optional(),
  context: interpretationContextSchema.optional(),
  assumptionsPolicy: assumptionsPolicySchema.optional(),
};

export const interpretArchitectureInputSchema = z.looseObject({
  ...architectureInputShape,
});

export const interpretArchitectureOutputSchema = architectureIRSchema;

export const moneySchema = z.looseObject({
  amount: z.number().nullable(),
  currency: z.string(),
  period: z.string(),
});

export const pricingLineItemSchema = z.looseObject({
  id: z.string(),
  description: z.string(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  rate: moneySchema.nullable(),
  cost: moneySchema.nullable(),
  provenance: provenanceSchema,
});

export const componentPricingPlanSchema = z.looseObject({
  componentId: z.string(),
  serviceId: z.string().nullable(),
  resolution: serviceResolutionSchema.nullable(),
  status: z.string(),
  calculatorServiceCode: z.string().nullable(),
  configuration: z.unknown(),
  lineItems: z.array(pricingLineItemSchema),
  cost: moneySchema.nullable(),
  assumptionIds: z.array(z.string()),
  warnings: z.array(z.string()),
  provenance: provenanceSchema,
});

export const pricingCoverageSchema = z.looseObject({
  status: z.string(),
  score: confidenceSchema,
  componentCount: z.number().int().nonnegative(),
  pricedComponentCount: z.number().int().nonnegative(),
  estimatedComponentCount: z.number().int().nonnegative(),
  unpricedComponentCount: z.number().int().nonnegative(),
  unpricedComponentIds: z.array(z.string()),
  gaps: z.array(z.string()),
});

export const calculatorEligibilitySchema = z.looseObject({
  eligible: z.boolean(),
  status: z.string(),
  eligibleComponentIds: z.array(z.string()),
  ineligibleComponentIds: z.array(z.string()),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
});

export const pricedScenarioSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  total: moneySchema,
  componentPlans: z.array(componentPricingPlanSchema),
  coverage: pricingCoverageSchema,
  eligibility: calculatorEligibilitySchema,
  assumptionIds: z.array(z.string()),
  warnings: z.array(z.string()),
  provenance: provenanceSchema,
});

export const priceArchitectureInputSchema = z.looseObject({
  ...architectureInputShape,
  architecture: z.unknown().optional(),
  architectureRef: architectureRefInputSchema.optional(),
  scenarioDefinitions: z.array(z.unknown()).optional(),
  pricingContext: openRecordSchema.optional(),
});

export const pricedArchitectureSchema = z.looseObject({
  contractVersion: z.literal(V2_CONTRACT_VERSION),
  kind: z.literal("priced_architecture"),
  pricingId: z.string(),
  architecture: architectureIRSchema,
  scenarios: z.array(pricedScenarioSchema),
  recommendedScenarioId: z.string().nullable(),
  coverage: pricingCoverageSchema,
  eligibility: calculatorEligibilitySchema,
  warnings: z.array(z.string()),
});

export const priceArchitectureOutputSchema = pricedArchitectureSchema;

export const generateCalculatorLinkInputSchema = z.looseObject({
  ...architectureInputShape,
  architecture: z.unknown().optional(),
  architectureRef: architectureRefInputSchema.optional(),
  pricedArchitecture: z.unknown().optional(),
  scenarioId: z.string().optional(),
  scenario: z.unknown().optional(),
  pricingContext: openRecordSchema.optional(),
  linkOptions: openRecordSchema.optional(),
});

export const calculatorLinkSchema = z.looseObject({
  url: z.string(),
  estimateId: z.string(),
  provider: z.string(),
  official: z.boolean(),
  readOnly: z.boolean(),
  createdAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export const generateCalculatorLinkOutputSchema = z.looseObject({
  contractVersion: z.literal(V2_CONTRACT_VERSION),
  kind: z.literal("calculator_link"),
  architecture: architectureIRSchema,
  selectedScenario: pricedScenarioSchema,
  link: calculatorLinkSchema,
  coverage: pricingCoverageSchema,
  eligibility: calculatorEligibilitySchema,
  warnings: z.array(z.string()),
});

export const v2ToolErrorSchema = z.looseObject({
  contractVersion: z.literal(V2_CONTRACT_VERSION),
  tool: z.enum([...V2_TOOL_NAMES]),
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.unknown().nullable(),
});

export const V2_TOOL_CONTRACTS = Object.freeze({
  list_service_catalog: {
    name: "list_service_catalog",
    description: "List discoverable AWS services and their calculator support.",
    inputSchema: listServiceCatalogInputSchema,
    outputSchema: listServiceCatalogOutputSchema,
  },
  interpret_architecture: {
    name: "interpret_architecture",
    description: "Interpret any architecture definition into provenance-aware graph IR.",
    inputSchema: interpretArchitectureInputSchema,
    outputSchema: interpretArchitectureOutputSchema,
  },
  price_architecture: {
    name: "price_architecture",
    description: "Resolve and price architecture components across open scenarios.",
    inputSchema: priceArchitectureInputSchema,
    outputSchema: priceArchitectureOutputSchema,
  },
  generate_calculator_link: {
    name: "generate_calculator_link",
    description: "Interpret, price, and generate an eligible AWS Calculator link.",
    inputSchema: generateCalculatorLinkInputSchema,
    outputSchema: generateCalculatorLinkOutputSchema,
  },
});

export function listV2ToolContracts() {
  return V2_TOOL_NAMES.map((toolName) => V2_TOOL_CONTRACTS[toolName]);
}

export function getV2ToolContract(toolName) {
  const contract = V2_TOOL_CONTRACTS[toolName];

  if (!contract) {
    throw new Error(
      `Unknown v2 tool contract '${toolName}'. Supported tools: ${V2_TOOL_NAMES.join(", ")}.`,
    );
  }

  return contract;
}

export function normalizeV2ToolOutput(toolName, structuredContent) {
  return getV2ToolContract(toolName).outputSchema.parse(structuredContent);
}

export function normalizeV2ToolError(errorPayload) {
  return v2ToolErrorSchema.parse(errorPayload);
}

function schemaDocument(schema, id, title) {
  return {
    $id: id,
    title,
    ...z.toJSONSchema(schema),
  };
}

export function createV2ContractManifest() {
  return {
    contractVersion: V2_CONTRACT_VERSION,
    tools: listV2ToolContracts().map((contract) => ({
      name: contract.name,
      description: contract.description,
      inputSchemaId: `aws-pricing-calculator-mcp.contract.v2.tools.${contract.name}.input`,
      outputSchemaId: `aws-pricing-calculator-mcp.contract.v2.tools.${contract.name}.output`,
    })),
    openIdentifiers: ["serviceId", "mediaType", "formatHint"],
  };
}

export function createV2ContractArtifacts() {
  const tools = Object.fromEntries(
    listV2ToolContracts().map((contract) => [
      contract.name,
      {
        input: schemaDocument(
          contract.inputSchema,
          `aws-pricing-calculator-mcp.contract.v2.tools.${contract.name}.input`,
          `${contract.name} input`,
        ),
        output: schemaDocument(
          contract.outputSchema,
          `aws-pricing-calculator-mcp.contract.v2.tools.${contract.name}.output`,
          `${contract.name} output`,
        ),
      },
    ]),
  );

  return {
    manifest: createV2ContractManifest(),
    toolError: schemaDocument(
      v2ToolErrorSchema,
      "aws-pricing-calculator-mcp.contract.v2.tool-error",
      "tool error",
    ),
    tools,
  };
}
