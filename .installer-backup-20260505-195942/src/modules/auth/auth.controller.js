const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../../config/db');
const { generateToken } = require('../../utils/jwt');

// ── SCHOOL ADMIN SIGNUP ──
const signup = async (req, res, next) => {
  try {
    const { email, password, firstName, lastName, schoolName, schoolAddress, schoolState } = req.body;

    if (!email || !password || !firstName || !lastName || !schoolName) {
      return res.status(400).json({ error: { message: 'All fields are required' } });
    }

    // Check if email already exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: { message: 'Email already registered' } });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Create school + admin user + first academic session in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: {
          name: schoolName,
          address: schoolAddress,
          state: schoolState,
        },
      });

      const user = await tx.user.create({
        data: {
          email,
          password: hashedPassword,
          firstName,
          lastName,
          role: 'SCHOOL_ADMIN',
          inviteAccepted: true,
          schoolId: school.id,
        },
      });

      // Create default academic session
      await tx.academicSession.create({
        data: {
          name: '2025/2026',
          currentTerm: 'FIRST',
          isCurrent: true,
          schoolId: school.id,
        },
      });

      return { school, user };
    });

    const token = generateToken(result.user.id, result.user.role);

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: result.user.id,
        email: result.user.email,
        firstName: result.user.firstName,
        lastName: result.user.lastName,
        role: result.user.role,
        schoolId: result.school.id,
        schoolName: result.school.name,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── LOGIN ──
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: { message: 'Email and password are required' } });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { school: { select: { id: true, name: true } } },
    });

    if (!user) {
      return res.status(401).json({ error: { message: 'Invalid email or password' } });
    }

    if (!user.isActive) {
      return res.status(401).json({ error: { message: 'Account is deactivated' } });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: { message: 'Invalid email or password' } });
    }

    const token = generateToken(user.id, user.role);

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        schoolId: user.school.id,
        schoolName: user.school.name,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── INVITE TEACHER (school admin only) ──
const inviteTeacher = async (req, res, next) => {
  try {
    const { email, firstName, lastName } = req.body;
    const { schoolId } = req.user;

    if (!email || !firstName || !lastName) {
      return res.status(400).json({ error: { message: 'Email, first name, and last name are required' } });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: { message: 'This email is already registered' } });
    }

    const inviteToken = crypto.randomBytes(32).toString('hex');

    const teacher = await prisma.user.create({
      data: {
        email,
        password: '', // Will be set when they accept the invite
        firstName,
        lastName,
        role: 'TEACHER',
        inviteToken,
        inviteAccepted: false,
        schoolId,
      },
    });

    // In production, send invite email here
    // For now, return the invite token
    const inviteLink = `${process.env.FRONTEND_URL}/invite/${inviteToken}`;

    res.status(201).json({
      message: 'Teacher invited successfully',
      teacher: {
        id: teacher.id,
        email: teacher.email,
        firstName: teacher.firstName,
        lastName: teacher.lastName,
      },
      inviteLink,
    });
  } catch (err) {
    next(err);
  }
};

// ── ACCEPT INVITE ──
const acceptInvite = async (req, res, next) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: { message: 'Password must be at least 6 characters' } });
    }

    const user = await prisma.user.findUnique({
      where: { inviteToken: token },
      include: { school: { select: { id: true, name: true } } },
    });

    if (!user) {
      return res.status(404).json({ error: { message: 'Invalid or expired invite' } });
    }

    if (user.inviteAccepted) {
      return res.status(400).json({ error: { message: 'Invite already accepted' } });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        inviteAccepted: true,
        inviteToken: null,
      },
    });

    const jwtToken = generateToken(user.id, user.role);

    res.json({
      message: 'Invite accepted. Welcome to KlassRun!',
      token: jwtToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        schoolId: user.school.id,
        schoolName: user.school.name,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── GET CURRENT USER ──
const me = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        school: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            sessions: { where: { isCurrent: true }, take: 1 },
          },
        },
      },
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        school: {
          id: user.school.id,
          name: user.school.name,
          logoUrl: user.school.logoUrl,
          currentSession: user.school.sessions[0] || null,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = { signup, login, inviteTeacher, acceptInvite, me };
