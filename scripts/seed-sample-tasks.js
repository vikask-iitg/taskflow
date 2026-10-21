// Adds sample tasks with upcoming due dates to an existing user.
// Usage: node scripts/seed-sample-tasks.js <email> [mongoUri]
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Task = require('../models/Task');

const SAMPLES = [
  { days: 3, time: '09:30', title: 'Pay electricity bill', description: 'Pay via the utility app before the late fee applies.', priority: 'high', category: 'Bills' },
  { days: 4, time: '18:00', title: 'Grocery shopping', description: 'Vegetables, milk, eggs, rice, cooking oil.', priority: 'medium', category: 'Groceries' },
  { days: 5, time: '07:00', title: 'Morning run - 5 km', description: 'Easy pace around the park.', priority: 'low', category: 'Health' },
  { days: 6, time: '11:00', title: 'Submit weekly report', description: 'Summarize progress, blockers and next steps for the team.', priority: 'high', category: 'Work' },
  { days: 7, time: '16:30', title: 'Car service appointment', description: 'Oil change and brake check at the service center.', priority: 'medium', category: 'Personal' },
  { days: 8, time: '20:00', title: 'Call parents', description: 'Weekly catch-up call.', priority: 'low', category: 'Family' },
  { days: 9, time: '10:00', title: 'Dentist check-up', description: 'Routine cleaning. Carry insurance card.', priority: 'medium', category: 'Health' },
  { days: 10, time: '14:00', title: 'Renew gym membership', description: 'Ask about the quarterly plan discount.', priority: 'low', category: 'Health' },
  { days: 12, time: '12:00', title: 'Pay credit card bill', description: 'Pay the full statement amount.', priority: 'high', category: 'Bills' },
  { days: 14, time: '19:00', title: 'Plan weekend trip', description: 'Shortlist places, check hotel prices and train tickets.', priority: 'low', category: 'Personal' },
  { days: 15, time: '09:00', title: 'Project milestone review', description: 'Prepare demo and slides for stakeholders.', priority: 'high', category: 'Work' },
  { days: 30, time: '10:00', title: 'Renew vehicle insurance', description: 'Compare quotes from at least three providers.', priority: 'high', category: 'Bills' },
];

function dueDateFor({ days, time }) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(h, m, 0, 0);
  return d;
}

(async () => {
  const [email, uri = process.env.MONGODB_URI] = process.argv.slice(2);
  if (!email || !uri || uri === 'memory') {
    console.error('Usage: node scripts/seed-sample-tasks.js <email> [mongoUri]');
    process.exit(1);
  }
  await mongoose.connect(uri);
  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) throw new Error(`No user with email ${email}`);
    const docs = SAMPLES.map(({ days, time, ...task }) => ({ ...task, userId: user._id, dueDate: dueDateFor({ days, time }) }));
    const created = await Task.insertMany(docs);
    created.forEach((t) => console.log(`${t.dueDate.toLocaleString()}  [${t.priority}]  ${t.title}`));
    console.log(`\nAdded ${created.length} tasks for ${user.name}`);
  } finally {
    await mongoose.disconnect();
  }
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
