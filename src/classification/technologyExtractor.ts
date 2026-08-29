import { uniqueStrings } from "../utils/text.js";

interface TechnologyRule {
  name: string;
  pattern: RegExp;
}

const TECHNOLOGIES: TechnologyRule[] = [
  { name: "Python", pattern: /\bpython\b/i },
  { name: "Java", pattern: /\bjava(?!script)\b/i },
  { name: "C++", pattern: /(?:\bc\+\+|\bcpp\b)/i },
  { name: "C#", pattern: /(?:\bc#|\bc sharp\b)/i },
  { name: "C", pattern: /(?:\bprogramming (?:in|with) c\b|\bc language\b|\bc\/c\+\+)/i },
  { name: "JavaScript", pattern: /\b(?:javascript|js)\b/i },
  { name: "TypeScript", pattern: /\btypescript\b/i },
  { name: "React", pattern: /\breact(?:\.js|js)?\b/i },
  { name: "Node.js", pattern: /\bnode(?:\.js|js)\b/i },
  { name: "Go", pattern: /\b(?:golang|go programming)\b/i },
  { name: "Rust", pattern: /\brust\b/i },
  { name: "Swift", pattern: /\bswift\b/i },
  { name: "Kotlin", pattern: /\bkotlin\b/i },
  { name: "Ruby", pattern: /\bruby\b/i },
  { name: "PHP", pattern: /\bphp\b/i },
  { name: "Scala", pattern: /\bscala\b/i },
  { name: "R", pattern: /\bR programming\b/i },
  { name: "SQL", pattern: /\b(?:sql|postgres(?:ql)?|mysql|sqlite)\b/i },
  { name: "NoSQL", pattern: /\b(?:nosql|mongodb|dynamodb|cassandra)\b/i },
  { name: "Git", pattern: /\b(?:git|github|gitlab|bitbucket)\b/i },
  { name: "AWS", pattern: /\b(?:aws|amazon web services)\b/i },
  { name: "Azure", pattern: /\b(?:azure|microsoft cloud)\b/i },
  { name: "GCP", pattern: /\b(?:gcp|google cloud)\b/i },
  { name: "Docker", pattern: /\bdocker\b/i },
  { name: "Kubernetes", pattern: /\b(?:kubernetes|k8s)\b/i },
  { name: "Terraform", pattern: /\bterraform\b/i },
  { name: "Linux", pattern: /\blinux\b/i },
  { name: "TensorFlow", pattern: /\btensorflow\b/i },
  { name: "PyTorch", pattern: /\bpytorch\b/i },
  { name: "scikit-learn", pattern: /\b(?:scikit-learn|sklearn)\b/i },
  { name: "Pandas", pattern: /\bpandas\b/i },
  { name: "Spark", pattern: /\b(?:apache )?spark\b/i },
  { name: "Hadoop", pattern: /\bhadoop\b/i },
  { name: "Kafka", pattern: /\b(?:apache )?kafka\b/i },
  { name: "Airflow", pattern: /\b(?:apache )?airflow\b/i },
  { name: "Snowflake", pattern: /\bsnowflake\b/i },
  { name: "Databricks", pattern: /\bdatabricks\b/i },
  { name: "GraphQL", pattern: /\bgraphql\b/i },
  { name: "REST APIs", pattern: /\b(?:rest(?:ful)? api|rest apis)\b/i },
  { name: "CI/CD", pattern: /\b(?:ci\s*\/\s*cd|continuous integration|continuous delivery)\b/i },
  { name: "Selenium", pattern: /\bselenium\b/i },
  { name: "Playwright", pattern: /\bplaywright\b/i },
  { name: "Cypress", pattern: /\bcypress\b/i },
  { name: "Unity", pattern: /\bunity\b/i },
  { name: "CUDA", pattern: /\bcuda\b/i },
  { name: "ROS", pattern: /\b(?:ros|robot operating system)\b/i },
];

export const TECHNOLOGY_NAMES = TECHNOLOGIES.map(({ name }) => name);

export function extractTechnologies(text: string): string[] {
  return uniqueStrings(TECHNOLOGIES.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name));
}
