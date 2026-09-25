import { z } from "zod";

const text = z.string().trim().min(1).max(2000);
const entry = z.object({ title: text, subtitle: text, date: text, bullets: z.array(text).max(8) });
export const resumeSchema = z.object({
  ownerEmail: z.email(),
  name: text,
  contact: z.array(text).min(1).max(8),
  education: z.array(entry).min(1).max(4),
  experience: z.array(entry).max(8),
  projects: z.array(entry).max(8),
  awards: z.array(text).max(6),
  skills: z.array(z.object({ label: text, items: z.array(text).max(40) })).max(8),
});
export type Resume = z.infer<typeof resumeSchema>;
export interface ResumeRole {
  title: string;
  company: string;
  description?: string | null;
  responsibilities?: string[];
  requiredQualifications?: string[];
  preferredQualifications?: string[];
  technologies?: string[];
}

const aliases: Record<string, string[]> = {
  javascript: ["javascript", "js"], typescript: ["typescript", "ts"],
  "node.js": ["node.js", "nodejs"], "next.js": ["next.js", "nextjs"],
  "c++": ["c++", "cpp"], "scikit-learn": ["scikit-learn", "sklearn"],
  testing: ["testing", "tests", "test", "qa", "quality assurance"],
  "machine learning": ["machine learning", "ml", "neural network"],
  "computer vision": ["computer vision", "vision", "opencv", "mediapipe"],
};
const stopWords = new Set("the and for with from this that will your our you are have has using into across among including software intern internship engineer engineering developed built implemented".split(" "));
function contains(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9+#])`, "i").test(haystack);
}

/** Reorder only supplied facts. Job text is data, never instructions or new claims. */
export function tailorResume(base: Resume, role: ResumeRole): { resume: Resume; matchedSkills: string[] } {
  const corpus = [role.title, role.description ?? "", ...(role.responsibilities ?? []), ...(role.requiredQualifications ?? []), ...(role.preferredQualifications ?? []), ...(role.technologies ?? [])].join(" ").slice(0, 150_000).toLowerCase();
  const skills = base.skills.flatMap((group) => group.items);
  const matches = (value: string) => (aliases[value.toLowerCase()] ?? [value.toLowerCase()]).some((term) => contains(corpus, term));
  const matchedSkills = skills.filter(matches);
  const keywords = [...new Set(corpus.match(/[a-z][a-z0-9+#.-]{2,}/g) ?? [])].filter((word) => !stopWords.has(word));
  const score = (value: string) => keywords.reduce((sum, term) => sum + Number(contains(value, term)), 0)
    + matchedSkills.reduce((sum, skill) => sum + (contains(value, skill) ? 5 : 0), 0)
    + Object.values(aliases).reduce((sum, terms) => sum + (terms.some((term) => contains(corpus, term)) && terms.some((term) => contains(value, term)) ? 3 : 0), 0);
  const rank = <T>(items: T[], content: (item: T) => string): T[] => [...items].sort((a, b) => score(content(b)) - score(content(a)));
  const reorderBullets = (item: Resume["projects"][number]) => ({ ...item, bullets: rank(item.bullets, (bullet) => bullet) });
  return {
    matchedSkills,
    resume: {
      ...base,
      experience: base.experience.map(reorderBullets), // Keep employment chronology intact.
      projects: rank(base.projects.map(reorderBullets), (item) => [item.title, item.subtitle, ...item.bullets].join(" ")),
      skills: base.skills.map((group) => ({ ...group, items: [...group.items].sort((a, b) => Number(matches(b)) - Number(matches(a))) })),
    },
  };
}

export function escapeLatex(value: string): string {
  const replacements: Record<string, string> = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "$": "\\$", "&": "\\&", "#": "\\#", "%": "\\%", "_": "\\_", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" };
  // Strip control characters before interpolation into TeX.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f]/g, " ").replace(/[\\{}$&#%_~^]/g, (character) => replacements[character]!);
}

export function renderLatex(resume: Resume): string {
  const e = escapeLatex;
  const entries = (items: Resume["projects"]) => items.map((item) => `\\noindent\\textbf{${e(item.title)}}\\hfill ${e(item.date)}\\\\
\\textit{${e(item.subtitle)}}
${item.bullets.length ? `\\begin{itemize}\n${item.bullets.map((bullet) => `\\item ${e(bullet)}`).join("\n")}\n\\end{itemize}` : "\\par\\vspace{3pt}"}`).join("\n");
  return String.raw`\documentclass[10pt,letterpaper]{article}
\usepackage[margin=0.55in]{geometry}
\usepackage{enumitem}
\usepackage{titlesec}
\usepackage[hidelinks]{hyperref}
\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlist[itemize]{leftmargin=14pt,itemsep=1pt,topsep=3pt,parsep=0pt}
\titleformat{\section}{\large\bfseries}{}{0em}{}[\titlerule]
\titlespacing*{\section}{0pt}{8pt}{4pt}
\begin{document}
\begin{center}
{\LARGE\bfseries ${e(resume.name)}}\\[3pt]
{\small ${resume.contact.map(e).join(" $|$ ")}}
\end{center}
\vspace{-10pt}
\section{Education}
${entries(resume.education)}
${resume.experience.length ? `\\section{Experience}\n${entries(resume.experience)}` : ""}
${resume.projects.length ? `\\section{Projects}\n${entries(resume.projects)}` : ""}
${resume.awards.length ? `\\section{Awards \\& Leadership}\n${resume.awards.map(e).join("\\\\\n")}` : ""}
\section{Technical Skills}
${resume.skills.map((group) => `\\textbf{${e(group.label)}:} ${group.items.map(e).join(", ")}`).join("\\\\\n")}
\end{document}
`;
}
