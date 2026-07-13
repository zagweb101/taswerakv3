import { db } from "@/lib/db";
import { LandingNavbar } from "@/components/landing/landing-navbar";
import { LandingFooter } from "@/components/landing/landing-footer";
import { CourseList } from "@/components/landing/course-list";
import { brandGradientText } from "@/lib/brand";

export const revalidate = 3600;

export const metadata = {
  title: "الدورات | تصويرك",
  description: "تصفّح كل دورات تصويرك — أساسيات التصوير، تصوير البيوتي، ميكب توتوريال.",
};

export default async function CoursesPage() {
  // Try DB first; fall back to static list if DB unavailable (e.g., dev sandbox)
  let courses: Array<{
    slug: string;
    titleAr: string | null;
    title: string;
    descriptionAr: string | null;
    description: string;
    price: any;
    durationHours: number;
    level: string;
    category: string | null;
  }> = [];

  try {
    const dbCourses = await db.course.findMany({
      where: { status: "PUBLISHED" },
      orderBy: [{ isFeatured: "desc" }, { createdAt: "asc" }],
      select: {
        slug: true,
        titleAr: true,
        title: true,
        descriptionAr: true,
        description: true,
        price: true,
        isFree: true,
        durationHours: true,
        level: true,
        category: true,
      },
    });
    courses = dbCourses.map((c) => ({
      ...c,
      price: c.price ? Number(c.price) : null,
    })) as any;
  } catch (err) {
    console.error("[courses] failed to load:", err);
    // DB unavailable — use empty list, page shows fallback
    courses = [];
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <LandingNavbar />
      <main className="flex-1">
        <section className="relative overflow-hidden border-b border-border/40">
          <div className="absolute inset-0 -z-10 brand-gradient-soft" />
          <div className="container mx-auto px-4 lg:px-8 py-12 lg:py-20 text-center">
            <h1 className="text-4xl lg:text-5xl font-extrabold">
              <span className={brandGradientText}>دورات تصويرك</span>
            </h1>
            <p className="text-muted-foreground mt-4 max-w-2xl mx-auto leading-relaxed">
              مجموعة متكاملة من الدورات المصمّمة بعناية، تأخذك من الأساسيات إلى
              التخصص الدقيق في تصوير البيوتي والمكياج.
            </p>
          </div>
        </section>

        <section className="container mx-auto px-4 lg:px-8 py-10 lg:py-14">
          <CourseList courses={courses as any} />
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
