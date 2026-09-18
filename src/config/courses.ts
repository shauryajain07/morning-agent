import { homedir } from "node:os";
import { join } from "node:path";

export const courseCodes = [
  "MATH1851",
  "ENGG1000",
  "ENGG1330",
  "CCHU9078",
  "ENGG1101FY",
] as const;

export type CourseCode = (typeof courseCodes)[number];

export type CourseConfig = {
  code: CourseCode;
  folder: string;
};

const hkuRoot = join(homedir(), "Documents", "HKU");

export const courses: Record<CourseCode, CourseConfig> = {
  MATH1851: { code: "MATH1851", folder: join(hkuRoot, "MATH1851") },
  ENGG1000: { code: "ENGG1000", folder: join(hkuRoot, "ENGG1000") },
  ENGG1330: { code: "ENGG1330", folder: join(hkuRoot, "ENGG1330") },
  CCHU9078: { code: "CCHU9078", folder: join(hkuRoot, "CCHU9078") },
  ENGG1101FY: { code: "ENGG1101FY", folder: join(hkuRoot, "ENGG1101FY") },
};

export const getCourse = (code: string): CourseConfig | undefined => {
  if (!courseCodes.includes(code as CourseCode)) return undefined;
  return courses[code as CourseCode];
};
