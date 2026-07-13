import { LandingNavbar } from "@/components/landing/landing-navbar";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingStats } from "@/components/landing/landing-stats";
import { LandingHowItWorks } from "@/components/landing/landing-how-it-works";
import { LandingCourses } from "@/components/landing/landing-courses";
import { LandingInstructor } from "@/components/landing/landing-instructor";
import { LandingTestimonials } from "@/components/landing/landing-testimonials";
import { LandingCTA } from "@/components/landing/landing-cta";
import { LandingFooter } from "@/components/landing/landing-footer";

// Force dynamic rendering — the landing page reads CMS content from the
// database at request time, so it cannot be statically prerendered at
// build time (the database is not available during `next build`).
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <LandingNavbar />
      <main className="flex-1">
        <LandingHero />
        <LandingStats />
        <LandingHowItWorks />
        <LandingCourses />
        <LandingInstructor />
        <LandingTestimonials />
        <LandingCTA />
      </main>
      <LandingFooter />
    </div>
  );
}
