// Prose written for the candidate: cover letters (coverLetter.js), application answers
// (answers.js) and referral requests (referral.js), each written once and checked for voice and
// facts (write.js), in the conventions of the job's market (conventions.js).

export { generateApplicationAnswer, generateApplicationAnswers } from './answers.js';
export { generateCoverLetter } from './coverLetter.js';
export { BLOCKING_INTRO_ISSUES, FOUNDER_INTRO_SYSTEM_PROMPT, INSTRUCTIONS_LIMIT, INTRO_MAX_WORDS, SUBJECT_LIMIT, buildFounderIntroPrompt, founderIntroIssues, generateFounderIntro, splitSubject, stripGreetingAndSignoff, wordCount } from './founderIntro.js';
export { conventionsOf, letterConventionsBlock, marketFor, readsAsEnglish } from './conventions.js';
export { buildReferralPrompt, CONNECTION_NOTE_LIMIT, fitConnectionNote, generateReferral, REFERRAL_FORMATS, REFERRAL_SYSTEM_PROMPT, referralIssues } from './referral.js';
export { withoutSubjectLine, writeInVoice } from './write.js';
