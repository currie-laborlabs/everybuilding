/**
 * Prompt builder — EveryBuilding Tier 2
 *
 * Pure function: given a fully-assembled PromptBuilderInput, returns a
 * Claude-ready system + user prompt pair.
 *
 * This module does NO I/O and makes NO external calls.
 * All data assembly (loading playbook, profile, resolving signature line)
 * happens in preparePromptInput.ts before calling buildPrompt().
 *
 * Output format:
 *   The system prompt instructs Claude to return a single JSON object.
 *   The validation layer in validation.ts parses that JSON before sending
 *   to Instantly.
 */

import type { PromptBuilderInput, PromptBuilderOutput } from "../types/prompt";
import type { ContactRoleAngle, CtaExample } from "../types/cta";
import type {
  SelectiveVoiceProfile,
  VoiceProfileSection,
  SenderIdentity,
  BrandVoice,
  Usp,
  SignatureProject,
  CustomerPraiseTheme,
  AssetsAvailable,
} from "../types/voice-profile";
import { resolvedSections } from "./selectVoiceProfile";

// ─── Role angle descriptions (injected into the system prompt) ────────────────

const ROLE_ANGLE_DESCRIPTIONS: Record<ContactRoleAngle, string> = {
  financial:
    "Focus on ROI, asset protection, deferred maintenance costs, and property value. " +
    "This person cares about the portfolio — not day-to-day details. " +
    "Lead with business impact, not technical features.",
  operational:
    "Focus on preventing downtime, maintenance cycles, avoiding emergency repairs, and " +
    "operational efficiency. This person manages the building day-to-day and wants " +
    "solutions that reduce their workload and avoid surprises.",
  practical:
    "Focus on tenant satisfaction, lease compliance, and keeping maintenance requests " +
    "low. This person deals with tenants and building owners directly — they need " +
    "reliable partners who show up as promised.",
  investment:
    "Focus on portfolio performance, cap rate protection, and how deferred maintenance " +
    "erodes valuation. This person thinks in assets and yield — frame everything as " +
    "protecting or improving their investment.",
};

// ─── Main builder ─────────────────────────────────────────────────────────────

/**
 * Assembles system and user prompts for one email from fully-prepared inputs.
 * Called after preparePromptInput() has loaded and assembled all dependencies.
 */
export function buildPrompt(input: PromptBuilderInput): PromptBuilderOutput {
  const { cta, role_angle, voice_profile, contact, signature_line } = input;

  const system_prompt = assembleSystemPrompt(input);
  const user_prompt = assembleUserPrompt(input);

  const voice_sections_used = resolvedSections(
    cta.voice_profile_sections
  ) as VoiceProfileSection[];

  return {
    system_prompt,
    user_prompt,
    cta_number: cta.cta_number,
    cta_name: cta.name,
    role_angle,
    voice_sections_used,
    signature_blurb_type: signature_line.blurb_type,
    built_at: new Date().toISOString(),
  };
}

// ─── System prompt assembly ───────────────────────────────────────────────────

function assembleSystemPrompt(input: PromptBuilderInput): string {
  const { cta, role_angle, voice_profile, contact, signature_line, campaign } = input;
  const sender = voice_profile.sender_identity;
  const basics = voice_profile.company_basics;
  const brandVoice = voice_profile.brand_voice;

  const sections: string[] = [];

  // ── Role definition ──────────────────────────────────────────────────────
  sections.push(
    [
      `You write cold outreach emails on behalf of ${basics?.company_name ?? campaign.client_name}, ` +
        `a ${basics?.primary_trade ?? "commercial contractor"} company.`,
      sender
        ? `You write as ${sender.sender_full_name}, ${sender.sender_title}. ` +
          `Sign off with the first name "${sender.sender_sign_off_name}". ` +
          `This is a real person — never write as an AI or use any AI-related framing.`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  );

  // ── About the company ────────────────────────────────────────────────────
  sections.push(renderCompanySection(voice_profile));

  // ── Brand voice ──────────────────────────────────────────────────────────
  if (brandVoice) {
    sections.push(renderBrandVoiceSection(brandVoice));
  }

  // ── CTA instructions ─────────────────────────────────────────────────────
  sections.push(
    [
      `## CTA — ${cta.display_name}`,
      cta.description,
      "",
      "Instructions:",
      cta.instructions,
    ].join("\n")
  );

  // ── Hard rules ───────────────────────────────────────────────────────────
  sections.push(renderRulesSection(input));

  // ── Role-based framing ───────────────────────────────────────────────────
  sections.push(
    [
      `## Role-Based Framing`,
      `The contact's title is: ${contact.contact_title}`,
      `Framing angle: ${role_angle}`,
      ROLE_ANGLE_DESCRIPTIONS[role_angle],
    ].join("\n")
  );

  // ── Signature line directive ──────────────────────────────────────────────
  sections.push(
    [
      `## Company Signature Line`,
      "Include exactly this sentence between the email body and your sign-off:",
      `"${signature_line.text}"`,
      "Do not modify it.",
    ].join("\n")
  );

  // ── Output format ────────────────────────────────────────────────────────
  sections.push(renderOutputFormatSection(input));

  return sections.join("\n\n");
}

// ─── User prompt assembly ─────────────────────────────────────────────────────

function assembleUserPrompt(input: PromptBuilderInput): string {
  const { cta, property, contact, voice_profile } = input;

  const sections: string[] = [];

  sections.push(
    `Write a cold outreach email using CTA #${cta.cta_number} — ${cta.display_name}.`
  );

  // ── Property data ────────────────────────────────────────────────────────
  sections.push(renderPropertySection(property));

  // ── Contact data ─────────────────────────────────────────────────────────
  sections.push(
    [
      "## Contact",
      `Name: ${contact.contact_name}`,
      `Title: ${contact.contact_title}`,
      `Outreach sequence: ${contact.sequence} contact at this building`,
    ].join("\n")
  );

  // ── Optional voice profile sections for user prompt context ──────────────
  const contextSections = renderUserPromptVoiceContext(voice_profile);
  if (contextSections) {
    sections.push(contextSections);
  }

  // ── Example emails ───────────────────────────────────────────────────────
  sections.push(renderExamplesSection(cta.examples, input.role_angle));

  return sections.join("\n\n");
}

// ─── Section renderers ────────────────────────────────────────────────────────

function renderCompanySection(vp: SelectiveVoiceProfile): string {
  const lines: string[] = ["## About the Company"];
  const basics = vp.company_basics;

  if (basics) {
    lines.push(
      `Name: ${basics.company_name}`,
      `Trade: ${basics.primary_trade}`,
      `${basics.years_in_business} years in business`,
      `Service area: ${basics.service_area}`
    );
    if (basics.licenses_and_certs.length > 0) {
      lines.push(`Certifications: ${basics.licenses_and_certs.join(", ")}`);
    }
  }

  if (vp.primary_usp) {
    lines.push("", renderUsp("Primary selling point", vp.primary_usp));
  }

  if (vp.additional_usps && vp.additional_usps.length > 0) {
    lines.push("", "Additional selling points:");
    vp.additional_usps.forEach((usp) => {
      lines.push(`  • ${renderUsp("", usp)}`);
    });
  }

  if (vp.market_positioning) {
    lines.push("", `Desired reputation: ${vp.market_positioning.desired_reputation}`);
    if (vp.market_positioning.price_positioning) {
      lines.push(`Price positioning: ${vp.market_positioning.price_positioning}`);
    }
  }

  return lines.join("\n");
}

function renderUsp(label: string, usp: Usp): string {
  const prefix = label ? `${label}: ` : "";
  return `${prefix}${usp.headline} — ${usp.supporting_detail}`;
}

function renderBrandVoiceSection(bv: BrandVoice): string {
  const lines: string[] = [
    "## Brand Voice",
    `Tone: ${bv.tone}`,
  ];

  if (bv.phrases_to_use.length > 0) {
    lines.push(
      "",
      "Phrases to use when natural:",
      bv.phrases_to_use.map((p) => `  • "${p}"`).join("\n")
    );
  }

  if (bv.phrases_to_avoid.length > 0) {
    lines.push(
      "",
      "Phrases NEVER to use (hard block):",
      bv.phrases_to_avoid.map((p) => `  • "${p}"`).join("\n")
    );
  }

  return lines.join("\n");
}

function renderRulesSection(input: PromptBuilderInput): string {
  const { cta, voice_profile, property } = input;

  // Build numbered rule list — global always-on rules first, then CTA-specific
  const rules: string[] = [
    `Email body must be under ${cta.word_limit} words. Count carefully before responding.`,
    `The email body MUST reference the building address "${property.property_address}" or a specific detail about the property.`,
    `This email uses CTA #${cta.cta_number} (${cta.name}). Do not switch to a different CTA type.`,
    cta.allow_link_in_body
      ? "A single URL is permitted in the email body for this CTA type."
      : "Do not include any URLs or hyperlinks in the email body. If the CTA involves sending a link, note that it will be sent upon reply.",
    voice_profile.sender_identity
      ? `The email must be signed from ${voice_profile.sender_identity.sender_full_name}. Do not use any other name.`
      : "The email must be signed from a real, named person.",
    `Do not use the word "just" anywhere in the email (e.g., "just wanted to", "just checking in").`,
    `Do not open with "I hope this email finds you well" or any AI-sounding opener.`,
    `Do not use phrases like "I wanted to reach out", "touch base", or "circle back".`,
  ];

  // Add competitor restriction if market_positioning is in scope
  const competitors = voice_profile.market_positioning?.competitors_to_avoid_mentioning ?? [];
  if (competitors.length > 0) {
    rules.push(`Never mention these competitor names: ${competitors.join(", ")}.`);
  }

  // Add CTA-specific rules from the playbook entry
  cta.rules.forEach((rule) => rules.push(rule));

  const numbered = rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n");

  return `## Hard Rules\nEvery rule below is non-negotiable. Violating any rule requires a retry.\n\n${numbered}`;
}

function renderOutputFormatSection(input: PromptBuilderInput): string {
  const { cta, voice_profile } = input;
  const sender = voice_profile.sender_identity;

  const signOff = sender?.sender_sign_off_name ?? "[sender first name]";
  const fullName = sender?.sender_full_name ?? "[sender full name]";
  const title = sender?.sender_title ?? "[sender title]";

  return [
    "## Output Format",
    "Return a single JSON object with exactly these keys. No text before or after the JSON.",
    "",
    "```json",
    "{",
    `  "subject": "Subject line here",`,
    `  "body": "Email body here — under ${cta.word_limit} words",`,
    `  "signature_line": "Company Signature Line here — use the exact line provided above",`,
    `  "sender_sign_off": "${signOff}",`,
    `  "sender_full_name": "${fullName}",`,
    `  "sender_title": "${title}",`,
    `  "word_count": 0,`,
    `  "cta_number_used": ${cta.cta_number},`,
    `  "cta_name_used": "${cta.name}"`,
    "}",
    "```",
    "",
    "Set word_count to the exact word count of the body field only (exclude subject, signature_line, and sign-off).",
  ].join("\n");
}

function renderPropertySection(
  property: PromptBuilderInput["property"]
): string {
  const lines: string[] = [
    "## Property",
    `Address: ${property.property_address}, ${property.city}, ${property.state} ${property.zip_code}`,
    `Building type: ${property.land_use}`,
  ];

  if (property.year_built !== null) {
    lines.push(`Year built: ${property.year_built}`);
  }

  if (property.square_feet !== null) {
    lines.push(`Size: ${property.square_feet.toLocaleString()} sqft`);
  }

  lines.push(`Owner entity: ${property.owner_entity}`);

  if (property.permit_summary) {
    lines.push(`Permit history: ${property.permit_summary}`);
  }

  if (property.roof_permit_date) {
    lines.push(`Most recent roof permit: ${property.roof_permit_date}`);
  }

  if (property.hvac_permit_date) {
    lines.push(`Most recent HVAC permit: ${property.hvac_permit_date}`);
  }

  if (property.last_sale_date) {
    lines.push(`Last recorded sale: ${property.last_sale_date}`);
  }

  if (property.tax_or_distress_notes) {
    lines.push(`Distress indicators: ${property.tax_or_distress_notes}`);
  }

  return lines.join("\n");
}

/**
 * Renders optional voice profile context in the user prompt.
 * These are reference data the LLM draws from when composing — not hard rules.
 */
function renderUserPromptVoiceContext(vp: SelectiveVoiceProfile): string {
  const sections: string[] = [];

  if (vp.signature_projects && vp.signature_projects.length > 0) {
    sections.push(renderSignatureProjects(vp.signature_projects));
  }

  if (vp.customer_praise_themes && vp.customer_praise_themes.length > 0) {
    sections.push(renderCustomerPraise(vp.customer_praise_themes));
  }

  if (vp.assets_available) {
    sections.push(renderAssetsAvailable(vp.assets_available));
  }

  return sections.join("\n\n");
}

function renderSignatureProjects(projects: SignatureProject[]): string {
  const lines = ["## Signature Projects (reference for this email if relevant)"];
  projects.slice(0, 3).forEach((p) => {
    const parts = [p.building_type, p.location];
    if (p.square_feet) parts.push(`${p.square_feet.toLocaleString()} sqft`);
    if (p.dollar_amount) parts.push(p.dollar_amount);
    lines.push(`  • ${parts.join(", ")} — ${p.outcome_summary}`);
  });
  return lines.join("\n");
}

function renderCustomerPraise(themes: CustomerPraiseTheme[]): string {
  const lines = ["## What Clients Say (reference for this email if relevant)"];
  themes
    .filter((t) => t.frequency === "high" || t.frequency === "medium")
    .slice(0, 3)
    .forEach((t) => {
      lines.push(`  • ${t.theme}`);
      if (t.example_quote) lines.push(`    "${t.example_quote}"`);
    });
  return lines.join("\n");
}

function renderAssetsAvailable(assets: AssetsAvailable): string {
  const available: string[] = [];
  if (assets.has_drone_footage) available.push("drone footage");
  if (assets.has_video_testimonials) available.push("video testimonials");
  if (assets.case_study_urls.length > 0) available.push("case studies");
  if (assets.youtube_channel_url) available.push("YouTube channel");

  if (available.length === 0) return "";

  return ["## Available Assets (reference for link-on-reply CTAs)", available.map((a) => `  • ${a}`).join("\n")].join("\n");
}

function renderExamplesSection(
  examples: [CtaExample, CtaExample],
  roleAngle: ContactRoleAngle
): string {
  // Put the example matching the current role angle first
  const ordered = orderExamples(examples, roleAngle);

  const lines = [
    "## Style Examples",
    "These are human-written example emails for this CTA type. Match the style, directness, and length.",
    "",
  ];

  ordered.forEach(([example, index]) => {
    lines.push(
      `### Example ${index + 1}`,
      `Subject: ${example.subject}`,
      "",
      example.body,
      ""
    );
  });

  return lines.join("\n");
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Returns examples as [example, originalIndex] pairs with the role-matching
 * example first so the LLM sees the most relevant style reference first.
 */
function orderExamples(
  examples: [CtaExample, CtaExample],
  roleAngle: ContactRoleAngle
): Array<[CtaExample, number]> {
  const [a, b] = examples;

  if (a.target_role === roleAngle) {
    return [
      [a, 0],
      [b, 1],
    ];
  }

  if (b.target_role === roleAngle) {
    return [
      [b, 1],
      [a, 0],
    ];
  }

  // Neither matches exactly — preserve original order
  return [
    [a, 0],
    [b, 1],
  ];
}
