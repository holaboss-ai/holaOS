function usage() {
  process.stderr.write(
    "Usage: node scripts/release-version.mjs [release-number] [--date YYYY-MM-DD] [--tag]\n",
  );
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseDateOnly(value) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function releaseVersion(date, releaseNumber) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1);
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}.${month}${day}.${releaseNumber}`;
}

function desktopReleaseTag(version) {
  return `holaOS-${version}`;
}

let releaseNumber = 1;
let date = new Date();
let printTag = false;

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--tag") {
    printTag = true;
    continue;
  }

  if (argument === "--date") {
    const value = process.argv[index + 1];
    if (!value) {
      usage();
      process.exit(1);
    }
    const parsedDate = parseDateOnly(value);
    if (!parsedDate) {
      process.stderr.write(`Invalid --date value: ${value}\n`);
      usage();
      process.exit(1);
    }
    date = parsedDate;
    index += 1;
    continue;
  }

  const parsedReleaseNumber = parsePositiveInteger(argument);
  if (parsedReleaseNumber == null) {
    process.stderr.write(`Invalid release number: ${argument}\n`);
    usage();
    process.exit(1);
  }
  releaseNumber = parsedReleaseNumber;
}

const version = releaseVersion(date, releaseNumber);
process.stdout.write(`${printTag ? desktopReleaseTag(version) : version}\n`);
