/**
 * Line-based readers for `.github/workflows/*.yml`, shared by the suites that
 * pin workflow structure. This is not a general YAML parser; it covers the
 * shapes `.github/workflows/` actually uses.
 */

/** The `jobs:` block of a workflow, split into `job id -> raw job body`. Inside
 *  `jobs:` the job ids are the only keys at two-space indentation; everything
 *  belonging to a job is indented further. Throws when a file has no `jobs:`
 *  block, so a renamed key fails loudly instead of yielding an empty map that
 *  every assertion on it would then pass vacuously.
 *
 *  A run of comment and blank lines immediately above a job id belongs to that
 *  job, not to the one that ends above it. Reading them the other way puts the
 *  prose that explains a job — including the sentences that name what the job
 *  must not contain — inside its neighbour's body. */
export function workflowJobs(source: string): Map<string, string> {
  const marker = "\njobs:\n";
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error("workflow has no top-level `jobs:` block");
  }
  const jobs = new Map<string, string>();
  let id: string | null = null;
  let body: string[] = [];
  for (const line of source.slice(start + marker.length).split("\n")) {
    const header = /^ {2}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/u.exec(line);
    if (header) {
      const preamble: string[] = [];
      while (
        body.length > 0 &&
        /^\s*(#.*)?$/u.test(body[body.length - 1] as string)
      ) {
        preamble.unshift(body.pop() as string);
      }
      if (id !== null) jobs.set(id, body.join("\n"));
      id = header[1] as string;
      body = preamble;
      continue;
    }
    body.push(line);
  }
  if (id !== null) jobs.set(id, body.join("\n"));
  return jobs;
}

/** Every shell command a job runs, in order, with block scalars (`run: |`)
 *  folded into one string.
 *
 *  Comments are excluded deliberately. Ordering invariants forbid certain
 *  scripts from sharing a job with the compile and test steps, and the
 *  workflows explain that rule in comments that name those very scripts — a
 *  substring scan over the raw job body would read those sentences as steps and
 *  fail on the explanation. */
export function jobRunCommands(jobBody: string): string[] {
  const commands: string[] = [];
  const lines = jobBody.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^( *)(- )?run:(.*)$/u.exec(lines[index] as string);
    if (!match) continue;
    const [, spaces = "", dash, rest = ""] = match;
    const indent = spaces.length + (dash ? dash.length : 0);
    const inline = rest.trim();
    if (inline !== "" && !/^[|>][-+]?\d*$/u.test(inline)) {
      commands.push(inline);
      continue;
    }
    const block: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] as string;
      if (line.trim() !== "" && line.length - line.trimStart().length <= indent) {
        break;
      }
      block.push(line.trim());
      index = next;
    }
    commands.push(block.join("\n"));
  }
  return commands;
}
