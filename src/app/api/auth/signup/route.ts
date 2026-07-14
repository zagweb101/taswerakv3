// ====================================================================
// Signup endpoint — creates a STUDENT account (default role)
// For instructor/admin creation, admin must use admin dashboard later.
// ====================================================================

import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { rateLimitPresets, getClientIP } from "@/lib/services/rate-limit";
import { sendWelcomeEmail } from "@/lib/services/marketing-email";

const schema = z.object({
  name: z.string().min(2, "الاسم قصير جداً"),
  email: z.string().email("بريد غير صحيح"),
  password: z
    .string()
    .min(8, "كلمة المرور يجب أن تكون 8 أحرف على الأقل")
    .regex(/[a-z]/, "كلمة المرور يجب أن تحتوي على حرف صغير واحد على الأقل")
    .regex(/[A-Z]/, "كلمة المرور يجب أن تحتوي على حرف كبير واحد على الأقل")
    .regex(/[0-9]/, "كلمة المرور يجب أن تحتوي على رقم واحد على الأقل")
    .regex(/[^a-zA-Z0-9]/, "كلمة المرور يجب أن تحتوي على رمز خاص واحد على الأقل"),
  phone: z.string().optional(),
  referralCode: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    // Rate limit: 5 signups per hour per IP
    const ip = getClientIP(req);
    const rl = rateLimitPresets.signup(ip);
    if (!rl.success) {
      return NextResponse.json(
        { ok: false, error: "محاولات كثيرة. حاول مرة أخرى بعد ساعة." },
        { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } }
      );
    }

    // Check if signup is enabled via admin settings
    try {
      const { db } = await import("@/lib/db");
      const settingsRow = await db.cmsContent.findUnique({
        where: { key: "admin_settings_flags" },
      });
      if (settingsRow) {
        const flags = JSON.parse(settingsRow.value);
        if (flags.enableSignup === false) {
          return NextResponse.json(
            { ok: false, error: "التسجيل موقّف حالياً. تواصل مع الإدارة." },
            { status: 403 }
          );
        }
      }
    } catch {
      // If settings check fails, allow signup (fail open for dev)
    }

    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return NextResponse.json(
        { ok: false, error: first?.message ?? "بيانات غير صحيحة" },
        { status: 400 }
      );
    }

    const { name, email, password, phone, referralCode } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const exists = await db.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (exists) {
      return NextResponse.json(
        { ok: false, error: "هذا البريد مسجّل مسبقاً" },
        { status: 409 }
      );
    }

    const hash = await bcrypt.hash(password, 12);

    // Generate referral code for new user (first 4 chars of name + random)
    const userReferralCode = `${(name || "TAS").replace(/\s/g, "").slice(0, 4).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const user = await db.user.create({
      data: {
        name,
        email: normalizedEmail,
        password: hash,
        phone: phone || null,
        role: "STUDENT",
      },
      select: { id: true, email: true, role: true, name: true },
    });

    // Store referral code + referral relationship in UserSettings
    const settings: any = { referralCode: userReferralCode, referrals: [], credit: 0 };

    // If came via referral, find referrer + add relationship
    if (referralCode) {
      try {
        // Find user with this referral code in their settings
        const allSettings = await db.userSettings.findMany({
          where: { data: { path: ["referralCode"], equals: referralCode } },
          select: { userId: true },
        });
        if (allSettings.length > 0) {
          const referrerId = allSettings[0].userId;
          settings.referredBy = referrerId;
          // Give 50 SAR credit to referrer
          const referrerSettings = await db.userSettings.findUnique({
            where: { userId: referrerId },
          });
          if (referrerSettings) {
            const referrerData: any = referrerSettings.data || {};
            referrerData.credit = (referrerData.credit || 0) + 50;
            referrerData.referrals = [...(referrerData.referrals || []), { userId: user.id, name, date: new Date().toISOString() }];
            await db.userSettings.update({
              where: { userId: referrerId },
              data: { data: referrerData },
            });
          }
        }
      } catch {
        // ignore referral errors
      }
    }

    // Save new user's settings
    try {
      await db.userSettings.create({
        data: { userId: user.id, data: settings },
      });
    } catch {
      // settings creation optional
    }

    // Send welcome email (async, non-blocking)
    sendWelcomeEmail(user.id).catch(() => {});

    return NextResponse.json({ ok: true, user });
  } catch (err) {
    console.error("[signup] error:", err);
    return NextResponse.json(
      { ok: false, error: "حدث خطأ، حاول مرة أخرى" },
      { status: 500 }
    );
  }
}
