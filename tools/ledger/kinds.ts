/** The stages of each kind of task, in the order a task goes through them. */
export const STAGES: Readonly<Record<'code' | 'docs' | 'investigation', readonly string[]>> = {
  code: ['plan', 'red', 'build', 'verify', 'review', 'pr'],
  docs: ['plan', 'build', 'review', 'pr'],
  investigation: ['plan', 'investigate', 'report', 'review'],
};
export type Kind = keyof typeof STAGES;
export const KINDS = Object.keys(STAGES).join(', ');
export const isKind = (kind: string): kind is Kind => Object.hasOwn(STAGES, kind);

/** Whether a task of `kind`, code when none, goes through `stage`. */
export const hasStage = (kind: string | undefined, stage: string): boolean => {
  const known = kind ?? 'code';
  return isKind(known) && STAGES[known].includes(stage);
};
