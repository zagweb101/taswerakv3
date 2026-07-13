// ====================================================================
// Taswerak — Production-ready Seed Script
//
// Behaviour:
//   - In production (NODE_ENV=production):
//       • Refuses to run if ENABLE_DEMO_SEED=true
//       • Creates first admin ONLY from env: SEED_ADMIN_EMAIL,
//         SEED_ADMIN_PASSWORD, SEED_ADMIN_NAME
//       • Refuses if SEED_ADMIN_PASSWORD < 12 chars or matches known weak
//         values ("Password123!", "taswerak", etc.)
//       • Demo instructor/student are skipped unless ENABLE_DEMO_SEED=true
//         (and that flag is rejected in production)
//   - In development/staging:
//       • Creates admin from env if provided, else uses safe dev defaults
//         (NOT committed — generated at runtime and printed once).
//       • Creates demo instructor + student + sample courses.
//   - Idempotent: re-running is safe (upsert / findFirst).
//   - No "Password123!" anywhere.
// ====================================================================

import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Role, CourseLevel, CourseStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const isProduction = process.env.NODE_ENV === "production";

// ---------- Database connection ----------
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("❌ DATABASE_URL is not set");
  process.exit(1);
}
if (isProduction) {
  const forbidden = [":taswerak@", "postgres:123456", "password=password"];
  if (forbidden.some((p) => databaseUrl.includes(p))) {
    console.error(
      "❌ DATABASE_URL contains a known dev/seed password. Refusing to seed in production."
    );
    process.exit(1);
  }
}

const pool = new Pool({ connectionString: databaseUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ---------- Weak-password blocklist ----------
const WEAK_PASSWORDS = [
  "Password123!",
  "password",
  "taswerak",
  "taswerak123",
  "admin",
  "12345678",
  "changeme",
  "change-me",
];

function isWeakPassword(pw: string): boolean {
  if (pw.length < 12) return true;
  const lower = pw.toLowerCase();
  return WEAK_PASSWORDS.some((w) => lower.includes(w.toLowerCase()));
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ ${name} is required in production seed`);
    process.exit(1);
  }
  return v;
}

async function main() {
  console.log("🌱 Seeding Taswerak...");
  console.log(`   NODE_ENV=${process.env.NODE_ENV || "development"}`);

  // ================================================================
  // 1. Admin — env-driven in production, optional in dev
  // ================================================================
  let adminEmail: string;
  let adminPassword: string;
  let adminName: string;

  if (isProduction) {
    if (process.env.ENABLE_DEMO_SEED === "true") {
      console.error("❌ ENABLE_DEMO_SEED=true is forbidden in production");
      process.exit(1);
    }
    adminEmail = requireEnv("SEED_ADMIN_EMAIL");
    adminPassword = requireEnv("SEED_ADMIN_PASSWORD");
    adminName = process.env.SEED_ADMIN_NAME || "System Admin";
    if (isWeakPassword(adminPassword)) {
      console.error(
        "❌ SEED_ADMIN_PASSWORD is too weak. Use ≥12 chars and avoid common patterns."
      );
      process.exit(1);
    }
  } else {
    // Dev / staging — env overrides defaults
    adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@taswerak.dev";
    adminPassword =
      process.env.SEED_ADMIN_PASSWORD ||
      // generate a strong ephemeral password for local dev
      `Dev-${crypto.randomBytes(12).toString("base64url")}`;
    adminName = process.env.SEED_ADMIN_NAME || "Dev Admin";
    if (isWeakPassword(adminPassword)) {
      console.warn(
        "⚠️  SEED_ADMIN_PASSWORD is weak — using it only because NODE_ENV is not production."
      );
    }
  }

  const adminHash = await bcrypt.hash(adminPassword, 12);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {}, // never overwrite an existing admin's password from seed
    create: {
      email: adminEmail,
      name: adminName,
      password: adminHash,
      role: Role.ADMIN,
      phone: process.env.SEED_ADMIN_PHONE || "+966500000000",
    },
  });
  console.log(`✅ Admin: ${admin.email}`);
  if (!isProduction && !process.env.SEED_ADMIN_PASSWORD) {
    console.log(
      `   (dev-only ephemeral password: ${adminPassword})\n` +
        `   Set SEED_ADMIN_PASSWORD to silence this.`
    );
  }

  // ================================================================
  // 2. Demo Instructor + Student (dev/staging only)
  // ================================================================
  let instructor: { id: string; email: string; name: string | null } | null = null;
  let student: { id: string; email: string; name: string | null } | null = null;

  const demoEnabled =
    !isProduction && process.env.ENABLE_DEMO_SEED === "true";

  if (demoEnabled) {
    const instructorEmail = "ahmed@taswerak.dev";
    const studentEmail = "student@taswerak.dev";
    // Dev-only strong passwords — randomly generated, printed once
    const demoInstructorPw = `Instructor-${crypto.randomBytes(8).toString("base64url")}`;
    const demoStudentPw = `Student-${crypto.randomBytes(8).toString("base64url")}`;

    instructor = await prisma.user.upsert({
      where: { email: instructorEmail },
      update: {},
      create: {
        email: instructorEmail,
        name: "أحمد زغلول",
        password: await bcrypt.hash(demoInstructorPw, 12),
        role: Role.INSTRUCTOR,
        phone: "+966500000001",
        bio: "مصور محترف ومدرّب تصوير مقيم في جدة. مؤسس منصة تصويرك.",
      },
    });

    student = await prisma.user.upsert({
      where: { email: studentEmail },
      update: {},
      create: {
        email: studentEmail,
        name: "طالبة تجريبية",
        password: await bcrypt.hash(demoStudentPw, 12),
        role: Role.STUDENT,
        phone: "+966500000002",
      },
    });

    console.log(`✅ Demo instructor: ${instructor.email} (pw: ${demoInstructorPw})`);
    console.log(`✅ Demo student:   ${student.email} (pw: ${demoStudentPw})`);

    // ================================================================
    // 3. Reference courses (demo only)
    // ================================================================
    const courses = [
      {
        slug: "photography-fundamentals",
        title: "Photography Fundamentals",
        titleAr: "أساسيات التصوير",
        description:
          "Course covers the foundational principles of photography: camera anatomy, exposure triangle, composition rules, lighting basics, and the journey from auto to manual mode.",
        descriptionAr:
          "دورة شاملة تغطي المبادئ الأساسية للتصوير الفوتوغرافي: تشريح الكاميرا، مثلث التعريض، قواعد التكوين، أساسيات الإضاءة، والرحلة من الوضع التلقائي إلى اليدوي.",
        price: 499,
        level: CourseLevel.BEGINNER,
        category: "أساسيات",
      },
      {
        slug: "beauty-photography-12-lectures",
        title: "Beauty Photography (12 Lectures)",
        titleAr: "تصوير البيوتي Beauty — 12 محاضرة",
        description:
          "A 12-lecture deep dive into beauty photography: studio setup, makeup collaboration, lighting for skin, retouching workflow, and building a beauty portfolio.",
        descriptionAr:
          "12 محاضرة متعمقة في تصوير البيوتي: تجهيز الاستوديو، التعاون مع خبيرة المكياج، إضاءة البشرة، سير عمل الريتوش، وبناء معرض أعمال البيوتي.",
        price: 899,
        level: CourseLevel.INTERMEDIATE,
        category: "بيوتي",
      },
      {
        slug: "makeup-tutorial-photography",
        title: "Makeup Tutorial Photography",
        titleAr: "ميكب توتوريال — تصوير دروس المكياج",
        description:
          "Specialized course on photographing makeup tutorials: macro lens work, color accuracy, step-by-step capture, and creating engaging tutorial content.",
        descriptionAr:
          "دورة متخصصة في تصوير دروس المكياج: العمل بعدسة الماكرو، دقة الألوان، الالتقاط خطوة بخطوة، وإنتاج محتوى توتوريال جذّاب.",
        price: 599,
        level: CourseLevel.INTERMEDIATE,
        category: "مكياج",
      },
    ];

    for (const c of courses) {
      const existing = await prisma.course.findUnique({ where: { slug: c.slug } });
      if (existing) continue;
      const course = await prisma.course.create({
        data: {
          ...c,
          currency: "SAR",
          status: CourseStatus.PUBLISHED,
          isFeatured: true,
          language: "ar",
          instructorId: instructor.id,
          sections: {
            create: [
              { title: "المقدمة", titleAr: "المقدمة", order: 0 },
              { title: "الأساسيات", titleAr: "الأساسيات", order: 1 },
            ],
          },
        },
        include: { sections: true },
      });

      const introSection = course.sections.find((s) => s.order === 0);
      const basicsSection = course.sections.find((s) => s.order === 1);
      if (introSection) {
        await prisma.lesson.create({
          data: {
            courseId: course.id,
            sectionId: introSection.id,
            title: "الترحيب والتعريف بالدورة",
            slug: "welcome",
            description: "تعريف عام بمحتويات الدورة وأهدافها",
            type: "VIDEO",
            order: 0,
            isPreview: true,
            videoUrl:
              "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
            duration: 180,
          },
        });
      }
      if (basicsSection) {
        await prisma.lesson.createMany({
          data: [
            {
              courseId: course.id,
              sectionId: basicsSection.id,
              title: "تشريح الكاميرا",
              slug: "camera-anatomy",
              description: "تعرّف على أجزاء الكاميرا الرئيسية وكيفية ضبطها",
              type: "VIDEO",
              order: 0,
              videoUrl:
                "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
              duration: 600,
            },
            {
              courseId: course.id,
              sectionId: basicsSection.id,
              title: "مثلث التعريض",
              slug: "exposure-triangle",
              description: "ISO، سرعة الغالق، فتحة العدسة — كيف تتفاعل معاً",
              type: "VIDEO",
              order: 1,
              videoUrl:
                "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
              duration: 720,
            },
          ],
        });
      }
      console.log(`✅ Course: ${c.titleAr}`);
    }

    // ================================================================
    // 3b. Active enrollment + assignment + sample submission
    // ================================================================
    const firstCourse = await prisma.course.findFirst({
      where: { slug: "photography-fundamentals" },
      include: { sections: { include: { lessons: true } } },
    });
    if (firstCourse) {
      const existingEnr = await prisma.enrollment.findUnique({
        where: {
          studentId_courseId: { studentId: student.id, courseId: firstCourse.id },
        },
      });
      if (!existingEnr) {
        const enrollment = await prisma.enrollment.create({
          data: {
            studentId: student.id,
            courseId: firstCourse.id,
            status: "ACTIVE",
            progress: 33,
          },
        });
        const secondLesson = firstCourse.sections?.[1]?.lessons?.[0];
        if (secondLesson) {
          const assignment = await prisma.assignment.create({
            data: {
              courseId: firstCourse.id,
              lessonId: secondLesson.id,
              title: "تمرين: صورة بإضاءة طبيعية",
              description: "التقط صورة بورتريه باستخدام الإضاءة الطبيعية من نافذة",
              instructions:
                "استخدم الإضاءة الجانبية من نافذة. اضبط ISO على 200، f/2.8، 1/125s.",
              requiresExif: true,
              maxAttempts: 3,
              order: 0,
              isPublished: true,
            },
          });
          const existingSub = await prisma.submission.findFirst({
            where: { assignmentId: assignment.id, studentId: student.id },
          });
          if (!existingSub) {
            await prisma.submission.create({
              data: {
                assignmentId: assignment.id,
                studentId: student.id,
                enrollmentId: enrollment.id,
                lessonId: secondLesson.id,
                imageUrl:
                  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800",
                caption: "صورة بورتريه بإضاءة النافذة الجانبية",
                exifData: {
                  camera: "Sony A7III",
                  lens: "85mm f/1.8",
                  iso: 200,
                  aperture: "f/2.8",
                  shutter: "1/125s",
                },
                status: "SUBMITTED",
                attemptNumber: 1,
              },
            });
          }
        }
      }

      const secondCourse = await prisma.course.findFirst({
        where: { slug: "beauty-photography-12-lectures" },
      });
      if (secondCourse) {
        const existingCert = await prisma.certificate.findFirst({
          where: { studentId: student.id, courseId: secondCourse.id },
        });
        if (!existingCert) {
          const enrollment2 = await prisma.enrollment
            .create({
              data: {
                studentId: student.id,
                courseId: secondCourse.id,
                status: "COMPLETED",
                progress: 100,
                completedAt: new Date(),
              },
            })
            .catch(() => null);
          if (enrollment2) {
            await prisma.certificate.create({
              data: {
                enrollmentId: enrollment2.id,
                studentId: student.id,
                courseId: secondCourse.id,
                certificateNumber: `TAS-2026-000001`,
                grade: "ممتاز",
                verifyToken: `tas_verify_${crypto.randomUUID()}`,
                status: "ISSUED",
              },
            });
          }
        }
      }
    }

    // ================================================================
    // 4. Featured testimonials (demo only)
    // ================================================================
    const testimonials = [
      {
        name: "صفاء",
        role: "طالبة تصوير",
        rating: 5,
        comment:
          "تجربة استثنائية مع تصويرك. تعلمت أساسيات لم أكن أعرفها من قبل، والشرح عملي ومباشر. أنصح كل من يريد دخول عالم التصوير البدء من هنا.",
      },
      {
        name: "أماني بخش",
        role: "مصورة بيوتي",
        rating: 5,
        comment:
          "دورة تصوير البيوتي غيّرت أسلوبي تماماً. الأستاذ أحمد يشرح تفاصيل دقيقة في الإضاءة والريتوش بطريقة سهلة. صرت أعمل جلسات احترافية بعد الدورة.",
      },
      {
        name: "المها اليازيدي",
        role: "صانعة محتوى مكياج",
        rating: 5,
        comment:
          "دورة ميكب توتوريال ممتازة جداً. تعلمت كيف أصوّر دروس المكياج باحترافية مع الحفاظ على دقة الألوان. المحتوى غني والتطبيق عملي.",
      },
    ];
    for (const t of testimonials) {
      const existing = await prisma.review.findFirst({ where: { name: t.name } });
      if (existing) continue;
      await prisma.review.create({
        data: { ...t, studentId: student.id, isFeatured: true, isPublished: true },
      });
      console.log(`✅ Testimonial: ${t.name}`);
    }
  } else {
    console.log("ℹ️  Demo seed disabled (set ENABLE_DEMO_SEED=true in dev to enable).");
  }

  console.log("🎉 Seed complete.");
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
