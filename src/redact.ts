// Mask secrets and personal data BEFORE anything leaves the machine.

export type RedactionResult = { text: string; counts: Record<string, number> };

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

type Rule = {
  name: string;
  re: RegExp;
  /** Return null to keep the original match. */
  replace: (match: string, ...groups: string[]) => string | null;
};

const tag = (name: string) => `[REDACTED_${name.toUpperCase()}]`;

// Order matters: most specific first.
const RULES: Rule[] = [
  {
    name: "private_key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => tag("private_key"),
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => tag("token"),
  },
  {
    name: "api_key",
    // OpenAI/Anthropic, Groq, Google, Hugging Face, GitLab, screenpipe, GitHub, Slack, AWS
    re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bgsk_[A-Za-z0-9]{20,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bhf_[A-Za-z0-9]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bsp-[A-Za-z0-9]{8,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => tag("api_key"),
  },
  {
    name: "bearer",
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
    replace: () => `Bearer ${tag("token")}`,
  },
  {
    name: "password",
    re: /\b(passwords?|passwd|pwd|mot de passe|mdp|secret|token|otp)(\s*[:=]\s*)(\S+)/gi,
    replace: (_m, key, sep) => `${key}${sep}${tag("password")}`,
  },
  {
    name: "iban",
    re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g,
    replace: () => tag("iban"),
  },
  {
    name: "card",
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    replace: (m) => (luhn(m.replace(/\D/g, "")) ? tag("card") : null),
  },
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: () => tag("email"),
  },
  {
    name: "phone",
    re: /(?:\+33\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/g,
    replace: () => tag("phone"),
  },
];

export function redact(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (match: string, ...rest: any[]) => {
      // rest = [...capture groups, offset, fullString]
      const groups = rest.slice(0, -2).map((g) => (g ?? "") as string);
      const out = rule.replace(match, ...groups);
      if (out === null) return match;
      counts[rule.name] = (counts[rule.name] ?? 0) + 1;
      return out;
    });
  }
  return { text, counts };
}

export const totalRedactions = (counts: Record<string, number>) =>
  Object.values(counts).reduce((a, b) => a + b, 0);
