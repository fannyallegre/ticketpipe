// Send the reviewed ticket to GitHub Issues (or save it locally in dry-run mode).
// To support another tracker (Jira, Linear, ServiceNow...), add a function with the same signature.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";

export type IssueInput = { title: string; body: string; labels?: string[] };
export type PublishResult = { url: string; number?: number; dryRun: boolean };

export async function publishIssue(issue: IssueInput): Promise<PublishResult> {
  if (!config.githubToken || !/^[\w.-]+\/[\w.-]+$/.test(config.githubRepo)) {
    return saveLocally(issue);
  }

  const res = await fetch(`https://api.github.com/repos/${config.githubRepo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "content-type": "application/json",
      "User-Agent": "ticketpipe",
    },
    body: JSON.stringify({ title: issue.title, body: issue.body, labels: issue.labels ?? [] }),
  });
  if (!res.ok) throw new Error(`GitHub API → HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = (await res.json()) as { html_url: string; number: number };
  return { url: json.html_url, number: json.number, dryRun: false };
}

async function saveLocally(issue: IssueInput): Promise<PublishResult> {
  await mkdir(config.ticketsDir, { recursive: true });
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const path = join(config.ticketsDir, `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${slug || "ticket"}.md`);
  const labels = issue.labels?.length ? `Labels: ${issue.labels.join(", ")}\n\n` : "";
  await Bun.write(path, `# ${issue.title}\n\n${labels}${issue.body}`);
  return { url: path, dryRun: true };
}

/** Checks the token can see the repo and create issues. Used by the "Test" button in Settings. */
export async function testGithub(): Promise<string> {
  if (!config.githubToken || !config.githubRepo) return `Tickets are saved to ${config.ticketsDir}`;
  const res = await fetch(`https://api.github.com/repos/${config.githubRepo}`, {
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ticketpipe",
    },
  });
  if (res.status === 404) throw new Error(`Repository ${config.githubRepo} not found, or the token can't see it.`);
  if (res.status === 401) throw new Error("GitHub rejected the token. Create a new one and paste it again.");
  if (!res.ok) throw new Error(`GitHub → HTTP ${res.status}`);
  const repo = (await res.json()) as { full_name: string; has_issues: boolean };
  if (!repo.has_issues) throw new Error(`Issues are turned off on ${repo.full_name}. Enable them in the repo settings.`);
  return repo.full_name;
}
