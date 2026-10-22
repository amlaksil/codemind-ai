// Prompt versions are recorded on every usage event and on what they produce, so
// a prompt change can be measured. Bump the version when the text changes. Every feature's
// version is here, so one file shows what each prompt is at.
export const PROMPT_VERSIONS = {
  score: 'score.v6',
  tailor: 'tailor.v16',
  coverLetter: 'coverLetter.v5',
  answer: 'answer.v5',
  parseResume: 'parseResume.v7',
  interviewPrep: 'interviewPrep.v2',
  interviewFeedback: 'interviewFeedback.v1',
  referral: 'referral.v1',
  founderIntro: 'founderIntro.v1',
  jobRequirements: 'jobRequirements.v4',
  jobEnrich: 'jobEnrich.v15',
  screeningInterpret: 'screeningInterpret.v1',
};
