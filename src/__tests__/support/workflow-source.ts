/** Parse only the workflow YAML shapes this repository uses. */

/** Require jobs to avoid vacuous success; leading job comments belong to that job. */
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

/** Exclude comments from command extraction so explanatory script names cannot satisfy ordering checks. */
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
