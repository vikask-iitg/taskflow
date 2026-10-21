const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const requireAuth = require('../middleware/auth');
const { sendMail, mailEnabled } = require('../lib/mailer');

const RESET_TTL_MINUTES = 30;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later' },
});

function signToken(user) {
  return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 8;
}

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }
    if (!validPassword(password)) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }
    const exists = await User.exists({ email: String(email).toLowerCase().trim() });
    if (exists) return res.status(409).json({ message: 'An account with this email already exists' });

    const user = await User.create({ name, email, password });
    res.status(201).json({ token: signToken(user), user });
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

    const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    res.json({ token: signToken(user), user });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Saves the dashboard Quick note (autosaved while the user types)
router.patch('/note', requireAuth, async (req, res, next) => {
  try {
    const note = typeof req.body.note === 'string' ? req.body.note : '';
    if (note.length > 10000) return res.status(400).json({ message: 'Note is too long (max 10,000 characters)' });
    req.user.note = note;
    req.user.noteUpdatedAt = new Date();
    await req.user.save();
    res.json({ note: req.user.note, noteUpdatedAt: req.user.noteUpdatedAt });
  } catch (err) {
    next(err);
  }
});

router.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ message: 'Display name is required' });
    req.user.name = name;
    await req.user.save();
    res.json({ user: req.user });
  } catch (err) {
    next(err);
  }
});

router.patch('/password', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required' });
    }
    if (!validPassword(newPassword)) {
      return res.status(400).json({ message: 'New password must be at least 8 characters' });
    }
    const user = await User.findById(req.user._id).select('+password');
    if (!(await user.comparePassword(currentPassword))) {
      return res.status(401).json({ message: 'Current password is incorrect' });
    }
    user.password = newPassword;
    await user.save();
    // Older sessions are now invalid, so hand this one a fresh token
    res.json({ message: 'Password updated', token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

// Starts a password reset. Always answers the same way so it can't be used to
// discover which emails have accounts.
router.post('/forgot', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').toLowerCase().trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ message: 'Please enter a valid email address' });

    const user = await User.findOne({ email });
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      user.resetTokenHash = sha256(token);
      user.resetTokenExpires = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);
      await user.save();

      // Built from APP_URL (not the request's Host header) so the link can't be pointed elsewhere
      const appUrl = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
      const link = `${appUrl}/#reset=${token}`;
      const sent = await sendMail({
        to: user.email,
        subject: 'Reset your TaskFlow password',
        text: `Hi ${user.name},\n\nUse this link to set a new TaskFlow password. It expires in ${RESET_TTL_MINUTES} minutes:\n\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
        html: `<p>Hi ${user.name.replace(/[<>&]/g, '')},</p><p>Use the button below to set a new TaskFlow password. The link expires in ${RESET_TTL_MINUTES} minutes.</p><p><a href="${link}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600">Reset password</a></p><p style="color:#6b7280">If you didn't ask for this, you can ignore this email.</p>`,
      }).catch((err) => {
        console.error('Password reset email failed:', err.message);
        return false;
      });
      if (!sent) {
        console.log(`\n[Password reset] ${user.email}\n  ${link}\n  (Email isn't configured, so the link is logged here. Set SMTP_* in .env to send real emails.)\n`);
      }
    }
    res.json({
      message: 'If an account exists for that email, a reset link is on its way.',
      emailEnabled: mailEnabled(),
    });
  } catch (err) {
    next(err);
  }
});

// Finishes a password reset with the token from the emailed link
router.post('/reset', authLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      return res.status(400).json({ message: 'This reset link is invalid. Please request a new one.' });
    }
    if (!validPassword(password)) return res.status(400).json({ message: 'Password must be at least 8 characters' });

    const user = await User.findOne({ resetTokenHash: sha256(token), resetTokenExpires: { $gt: new Date() } })
      .select('+resetTokenHash +resetTokenExpires');
    if (!user) return res.status(400).json({ message: 'This reset link is invalid or has expired. Please request a new one.' });

    user.password = password;
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    await user.save();
    res.json({ message: 'Your password has been reset. You can now log in.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
