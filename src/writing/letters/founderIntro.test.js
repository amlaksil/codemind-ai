import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeLlm } from '../../testing/fakeLlm.js';
import { BLOCKING_INTRO_ISSUES, INSTRUCTIONS_LIMIT, buildFounderIntroPrompt, founderIntroIssues, generateFounderIntro, splitSubject, stripGreetingAndSignoff, wordCount } from './founderIntro.js';

const resumeText = 'Backend engineer. Built Go services for 2,000 merchants at Acme. Led a team of 4.';
const good =
  'Your posting mentions moving the payments ledger off a monolith, which is the work I have done for three years. At Acme I built the Go services that 2,000 merchants settle through, and I have led a team of 4 through a migration like the one you describe. I would like to do this for a smaller team where the decisions are closer.\n\nWould a short call next week make sense, or is there a better place to send an application?';

let llm;
afterEach(() => {
  llm?.restore();
  llm = null;
});

test('the prompt names the recipient by role only, the company, the role, the posting, the resume and the member\'s instructions', () => {
  const prompt = buildFounderIntroPrompt({ founderRole: 'Co-founder & CTO', company: 'Globex', jobTitle: 'Backend Engineer', jobDescription: 'Move the ledger.', resumeText, instructions: 'casual, mention Go' });
  assert.match(prompt, /RECIPIENT: the Co-founder & CTO of Globex \(name unknown to you\)/);
  assert.match(prompt, /ROLE: Backend Engineer/);
  assert.match(prompt, /Move the ledger\./);
  assert.match(prompt, /MEMBER_INSTRUCTIONS:\ncasual, mention Go/);
  assert.match(prompt, /2,000 merchants/);
  // No role known: a founder. No instructions: no section.
  const bare = buildFounderIntroPrompt({ company: 'Globex', jobTitle: 'X', resumeText });
  assert.match(bare, /RECIPIENT: a founder of Globex/);
  assert.doesNotMatch(bare, /MEMBER_INSTRUCTIONS/);
  // Instructions are cut to their limit.
  const long = buildFounderIntroPrompt({ company: 'G', jobTitle: 'X', resumeText, instructions: 'a'.repeat(INSTRUCTIONS_LIMIT + 50) });
  assert.equal(long.match(/a+/g).sort((x, y) => y.length - x.length)[0].length, INSTRUCTIONS_LIMIT);
});

test('the subject line is split off, however the model wrote it', () => {
  assert.deepEqual(splitSubject('Subject: Backend Engineer at Globex\n\nBody here.'), { subject: 'Backend Engineer at Globex', note: 'Body here.' });
  assert.deepEqual(splitSubject('**Subject:** "Your ledger work"\nBody.'), { subject: 'Your ledger work', note: 'Body.' });
  assert.deepEqual(splitSubject('"Just a body."'), { subject: '', note: 'Just a body.' });
});

test('a greeting line and a sign-off are stripped; the body stays', () => {
  assert.equal(stripGreetingAndSignoff('Hi there,\n\nBody paragraph.\n\nBest regards,\nJane Doe'), 'Body paragraph.');
  assert.equal(stripGreetingAndSignoff('Dear founder:\nBody.\nThanks,\nJane'), 'Body.');
  assert.equal(stripGreetingAndSignoff('Body only.\n\nLooking forward to hearing from you.'), 'Body only.');
  assert.equal(stripGreetingAndSignoff('Hiring is hard. Body.'), 'Hiring is hard. Body.', 'a sentence starting with "Hi" is not a greeting');
});

test('a note is checked for invented facts, claims of prior contact, framing and length', () => {
  const codes = (text) => founderIntroIssues(text, { resumeText }).map((i) => i.code);
  assert.deepEqual(codes(good), []);
  assert.ok(codes(good.replace('2,000 merchants', '20,000 merchants')).includes('fact'));
  assert.ok(codes(`Great talking with you last week. ${good}`).includes('relationship'));
  assert.ok(codes(`Hi Sarah,\n${good}`).includes('frame'));
  assert.ok(codes(`${good}\n\nBest,\nJane`).includes('frame'));
  assert.ok(codes('Short.').includes('length'));
  assert.ok(codes(`${good} ${'and more words here. '.repeat(70)}`).includes('length'));
  assert.ok(codes(good.replace('built the Go services', 'leveraged Go to build robust services')).includes('ai_tell'));
  assert.deepEqual([...BLOCKING_INTRO_ISSUES].sort(), ['fact', 'relationship']);
  assert.equal(wordCount(' a  b\nc '), 3);
});

test('a draft comes back as subject and body, framed and checked, metered as a founder intro', async () => {
  llm = installFakeLlm([`Subject: Backend Engineer at Globex\n\nHi there,\n\n${good}\n\nBest,\nJane`]);
  const out = await generateFounderIntro({ founderRole: 'CTO', company: 'Globex', jobTitle: 'Backend Engineer', jobDescription: 'Move the ledger.', resumeText, instructions: 'casual' }, { userId: 'u1' });
  assert.equal(out.subject, 'Backend Engineer at Globex');
  assert.equal(out.note, good);
  assert.deepEqual(out.warnings, []);
  assert.equal(llm.calls.length, 1, 'a clean draft is not revised');
  assert.equal(llm.events[0].kind, 'founder_intro');
  assert.match(llm.calls[0].request.messages[0].content, /never met or spoken/);
  assert.match(llm.calls[0].request.messages[1].content, /MEMBER_INSTRUCTIONS:\ncasual/);
});

test('a draft with a problem is revised once; a missing subject gets a plain one', async () => {
  llm = installFakeLlm([`Subject: X\n\nWe met at the meetup. ${good}`, good]);
  const out = await generateFounderIntro({ company: 'Globex', jobTitle: 'Backend Engineer', resumeText }, {});
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].request.messages[1].content, /REVISE: .*never been in touch/s);
  assert.equal(out.note, good);
  assert.equal(out.subject, 'Backend Engineer at Globex', 'the revision had no subject line: the role names it');
});
