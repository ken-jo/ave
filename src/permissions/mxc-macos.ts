const PROFILE_BEGIN = "Seatbelt: --- begin generated profile ---";
const PROFILE_END = "Seatbelt: --- end generated profile ---";

class SeatbeltProfileError extends Error {
  readonly code = "profile-unreadable";

  constructor() {
    super("Could not read the generated container profile");
    this.name = "SeatbeltProfileError";
  }
}

export function parseSeatbeltProfile(output: string): string {
  let begin = -1;
  let end = -1;
  const lines = output.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line === PROFILE_BEGIN) {
      if (begin !== -1 || end !== -1) throw new SeatbeltProfileError();
      begin = index;
    } else if (line === PROFILE_END) {
      if (begin === -1 || end !== -1) throw new SeatbeltProfileError();
      end = index;
    }
  }

  if (begin === -1 || end === -1) throw new SeatbeltProfileError();
  const profile = lines.slice(begin + 1, end).join("\n") + "\n";
  if (!profile.startsWith("(version 1)\n(deny default)\n")) throw new SeatbeltProfileError();
  return profile;
}
