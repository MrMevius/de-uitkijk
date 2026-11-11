export interface Release {
  version: string;
  date: string;
  items: string[];
}

/** Releases from CHANGELOG.md: a `## <version> — <date>` heading followed by `- ` bullets, newest first. */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = [];
  for (const line of markdown.split('\n')) {
    const heading = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (heading) releases.push({ version: heading[1]!, date: heading[2]!, items: [] });
    else if (line.startsWith('- ') && releases.length) releases.at(-1)!.items.push(line.slice(2).trim());
  }
  return releases;
}
