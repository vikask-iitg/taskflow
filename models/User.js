const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60 },
    email: {
      type: String,
      required: true,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
    },
    password: { type: String, required: true, minlength: 8, select: false },
    // Free-form "Quick note" shown on the dashboard
    note: { type: String, default: '', maxlength: 10000 },
    noteUpdatedAt: { type: Date, default: null },
    // Password reset: only a SHA-256 hash of the emailed token is stored
    resetTokenHash: { type: String, select: false },
    resetTokenExpires: { type: Date, select: false },
    // Logins issued before this moment are rejected (see middleware/auth.js)
    passwordChangedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
  if (!this.isNew) this.passwordChangedAt = new Date();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toJSON = function toJSON() {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    createdAt: this.createdAt,
    note: this.note || '',
    noteUpdatedAt: this.noteUpdatedAt,
  };
};

module.exports = mongoose.model('User', userSchema);
