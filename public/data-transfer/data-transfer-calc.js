/**
 * Pure cost model for the data transfer estimator (unit-tested with vitest;
 * DOM wiring lives in data-transfer-page.js).
 *
 * The model compares two ways of running a VPC workload in private subnets:
 *
 *   - "All via NAT": every AWS-service call and all internet egress goes
 *     through NAT gateways: hourly per gateway plus per-GB processing (plus
 *     the tiered internet-egress rate on traffic that leaves AWS).
 *   - "With VPC endpoints": S3 and DynamoDB run through free gateway
 *     endpoints, and traffic to other AWS services runs through interface
 *     endpoints (PrivateLink): hourly per endpoint per AZ plus a per-GB
 *     processing fee instead of NAT processing.
 *
 * Cross-AZ and cross-region traffic between the user's own resources does
 * not traverse NAT gateways and is billed the same in both scenarios (it is
 * included so the estimate covers the whole transfer bill).
 *
 * Not modeled (surfaced as notes): VPC peering / Transit Gateway charges,
 * CloudFront, S3-specific egress rates, public IPv4 charges, NAT gateway
 * processing on cross-region traffic that routes through the internet.
 */

/** Billing hours per month, matching the AWS pricing pages. */
export const HOURS_PER_MONTH = 730;

/** Traffic rows the page renders, in display order. */
export const TRAFFIC_ROWS = [
  { key: "s3Gb", label: "S3", hint: "gateway endpoint (free)" },
  { key: "dynamodbGb", label: "DynamoDB", hint: "gateway endpoint (free)" },
  { key: "otherAwsGb", label: "Other AWS services", hint: "interface endpoints" },
  { key: "internetGb", label: "Internet (egress to clients)", hint: "NAT + egress tiers" },
  { key: "crossAzGb", label: "Cross-AZ (own resources)", hint: "unchanged by endpoints" },
  { key: "crossRegionGb", label: "Cross-region (own resources)", hint: "unchanged by endpoints" },
];

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * Cost of `gb` against ascending tiers [{upToGb, perGbUsd}] (upToGb null =
 * unbounded). Mirrors tieredStorageCost in the S3 model.
 */
export function tieredCost(gb, tiers) {
  let remaining = Math.max(0, gb);
  let cost = 0;
  let from = 0;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const capacity = tier.upToGb === null ? Infinity : Math.max(0, tier.upToGb - from);
    const used = Math.min(remaining, capacity);
    cost += used * tier.perGbUsd;
    remaining -= used;
    if (tier.upToGb !== null) from = tier.upToGb;
  }
  return cost;
}

/** The per-GB rate tieredCost applies to the first byte after `gb` GB. */
function marginalRate(gb, tiers) {
  for (const tier of tiers) {
    if (tier.upToGb === null || gb < tier.upToGb) return tier.perGbUsd;
  }
  return tiers[tiers.length - 1].perGbUsd;
}

/**
 * @param {object} pricingDoc - public/data/data-transfer-pricing.json
 * @param {object} inputs
 * @param {string} inputs.region - source region code
 * @param {number} inputs.azCount - AZs carrying a NAT gateway / endpoints (1-3)
 * @param {number} inputs.interfaceEndpointCount - distinct interface endpoints
 * @param {object} inputs.traffic - GB per month, keyed by TRAFFIC_ROWS
 * @param {string} [inputs.crossRegionDest] - destination region code
 */
export function computeDataTransferCost(pricingDoc, inputs) {
  const region = pricingDoc.regions.find((r) => r.code === inputs.region);
  if (!region) return { ok: false, error: `unknown region ${inputs.region}` };
  const prices = pricingDoc.prices[region.code];

  const azCount = Math.min(3, Math.max(1, Math.round(num(inputs.azCount) || 1)));
  const endpointCount = Math.max(0, Math.round(num(inputs.interfaceEndpointCount)));

  const t = inputs.traffic ?? {};
  const s3Gb = num(t.s3Gb);
  const dynamodbGb = num(t.dynamodbGb);
  const otherAwsGb = num(t.otherAwsGb);
  const internetGb = num(t.internetGb);
  const crossAzGb = num(t.crossAzGb);
  const crossRegionGb = num(t.crossRegionGb);

  let interRegionOutPerGb = null;
  let interRegionDest;
  if (crossRegionGb > 0) {
    const destCode = inputs.crossRegionDest;
    const dest = pricingDoc.regions.find((r) => r.code === destCode);
    if (!dest || dest.code === region.code) {
      return {
        ok: false,
        error: dest ? "cross-region destination must differ from the source region" : `unknown region ${destCode}`,
      };
    }
    interRegionDest = dest;
    // Absent keys are AWS price-list gaps (see missingPairs in the dataset);
    // the line is then flagged instead of priced.
    interRegionOutPerGb = prices.interRegionOut[dest.code] ?? null;
  }

  // Consumption that NAT processes in each scenario.
  const natProcessedNatOnlyGb = s3Gb + dynamodbGb + otherAwsGb + internetGb;
  const natProcessedWithEndpointsGb = internetGb;

  const natHourly = azCount * HOURS_PER_MONTH * prices.natGateway.hourUsd;
  const natProcessingNatOnly = natProcessedNatOnlyGb * prices.natGateway.gbUsd;
  const natProcessingWithEndpoints = natProcessedWithEndpointsGb * prices.natGateway.gbUsd;

  // Internet egress: tiered rates apply beyond the 100 GB/month free tier.
  const freeGb = Math.min(pricingDoc.internetOutFreeGb ?? 0, internetGb);
  const billableGb = Math.max(0, internetGb - freeGb);
  const internetEgressCost = tieredCost(billableGb, prices.internetOutTiers);

  const crossAzCost = crossAzGb * 2 * prices.crossAzPerGb; // in + out, same rate
  const crossRegionCost = crossRegionGb * (interRegionOutPerGb ?? 0);
  const crossRegionUnpriced = crossRegionGb > 0 && interRegionOutPerGb === null;

  const endpointHourly = endpointCount * azCount * HOURS_PER_MONTH * prices.interfaceEndpoint.hourUsd;
  const endpointProcessing = tieredCost(otherAwsGb, prices.interfaceEndpoint.gbTiers);

  const natLines = [
    { key: "nat-hours", label: "NAT gateway hours", usd: natHourly },
    { key: "nat-processing", label: "NAT data processing", usd: natProcessingNatOnly },
    { key: "internet-egress", label: "Internet egress tiers", usd: internetEgressCost },
    { key: "cross-az", label: "Cross-AZ transfer", usd: crossAzCost, gb: crossAzGb },
    {
      key: "cross-region",
      label: "Cross-region transfer",
      usd: crossRegionCost,
      gb: crossRegionGb,
      unpriced: crossRegionUnpriced,
    },
  ].map((line) => ({ ...line, usd: round(line.usd) }));

  const endpointLines = [
    { key: "nat-hours", label: "NAT gateway hours", usd: natHourly },
    { key: "nat-processing", label: "NAT data processing", usd: natProcessingWithEndpoints },
    { key: "endpoint-hours", label: "Interface endpoint hours", usd: endpointHourly },
    { key: "endpoint-processing", label: "Interface endpoint processing", usd: endpointProcessing },
    { key: "internet-egress", label: "Internet egress tiers", usd: internetEgressCost },
    { key: "cross-az", label: "Cross-AZ transfer", usd: crossAzCost, gb: crossAzGb },
    {
      key: "cross-region",
      label: "Cross-region transfer",
      usd: crossRegionCost,
      gb: crossRegionGb,
      unpriced: crossRegionUnpriced,
    },
  ].map((line) => ({ ...line, usd: round(line.usd) }));

  const natTotal = natLines.reduce((sum, line) => sum + line.usd, 0);
  const endpointTotal = endpointLines.reduce((sum, line) => sum + line.usd, 0);
  // Sums of rounded lines drift; keep the totals consistently rounded.
  const natTotalRounded = round(natTotal);
  const endpointTotalRounded = round(endpointTotal);

  // Break-even per interface endpoint: its hourly cost (across the AZs it is
  // deployed in) divided by the per-GB saving vs. NAT processing. The set of
  // endpoints breaks even at per-service volume x endpoint count.
  let breakEven = null;
  if (endpointCount > 0) {
    const perGbSaving = prices.natGateway.gbUsd - marginalRate(otherAwsGb, prices.interfaceEndpoint.gbTiers);
    const hourlyTotal = azCount * HOURS_PER_MONTH * prices.interfaceEndpoint.hourUsd;
    const perServiceGb = perGbSaving > 0 ? hourlyTotal / perGbSaving : null;
    breakEven = {
      perServiceGb: perServiceGb === null ? null : round(perServiceGb),
      combinedGb: perServiceGb === null ? null : round(perServiceGb * endpointCount),
      servicesGb: otherAwsGb,
      worthIt: perServiceGb !== null && otherAwsGb > perServiceGb * endpointCount,
    };
  }

  const notes = [];
  if (s3Gb + dynamodbGb > 0) {
    notes.push(
      "S3 and DynamoDB gateway endpoints are free: removing that traffic from NAT processing is savings with no added hourly cost.",
    );
  }
  if (endpointCount > 0 && breakEven) {
    if (breakEven.perServiceGb === null) {
      notes.push("This region has no per-GB saving vs. NAT processing; interface endpoints do not pay off.");
    } else if (breakEven.worthIt) {
      notes.push(
        `Interface endpoints pay off: ${otherAwsGb.toLocaleString()} GB/month of other-services traffic exceeds the combined break-even of ${breakEven.combinedGb.toLocaleString()} GB/month for ${endpointCount} endpoint${endpointCount > 1 ? "s" : ""} across ${azCount} AZ${azCount > 1 ? "s" : ""}.`,
      );
    } else {
      notes.push(
        `Interface endpoints do not pay off at this volume: they need more than ${breakEven.combinedGb.toLocaleString()} GB/month of other-services traffic for ${endpointCount} endpoint${endpointCount > 1 ? "s" : ""} across ${azCount} AZ${azCount > 1 ? "s" : ""}, and this estimate has ${otherAwsGb.toLocaleString()} GB/month.`,
      );
    }
  }
  if (internetGb > 0 && freeGb > 0) {
    notes.push(
      `${freeGb} GB of the internet egress lands in the global monthly free tier (which AWS aggregates across all services and regions).`,
    );
  }
  if (crossRegionGb > 0 && crossRegionUnpriced) {
    notes.push(
      `AWS publishes no inter-region outbound rate for ${region.code} to ${interRegionDest.name} (${interRegionDest.code}); that traffic is left out of the totals.`,
    );
  } else if (crossRegionGb > 0) {
    notes.push(
      "Cross-region pricing is the outbound pair rate; inbound inter-region transfer is $0.00 in the current price list. Transit Gateway / VPC peering charges are not included.",
    );
  }

  return {
    ok: true,
    region: region.code,
    azCount,
    interfaceEndpointCount: endpointCount,
    scenarios: {
      nat: { lines: natLines, total: natTotalRounded },
      endpoints: { lines: endpointLines, total: endpointTotalRounded },
    },
    savings: round(natTotalRounded - endpointTotalRounded),
    savingsPerYear: round((natTotalRounded - endpointTotalRounded) * 12),
    internet: {
      gb: internetGb,
      freeGb,
      billableGb,
      cost: round(internetEgressCost),
    },
    breakEven,
    rates: {
      natHourUsd: prices.natGateway.hourUsd,
      natGbUsd: prices.natGateway.gbUsd,
      endpointHourUsd: prices.interfaceEndpoint.hourUsd,
      endpointGbTiers: prices.interfaceEndpoint.gbTiers,
      crossAzPerGb: prices.crossAzPerGb,
      interRegionOutPerGb,
      internetOutTiers: prices.internetOutTiers,
    },
    notes,
  };
}
