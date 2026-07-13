import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

// Get all lessons for a course (optionally filter by section)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const { searchParams } = new URL(request.url);
  const sectionId = searchParams.get("sectionId");
  const whereClause: any = { courseId };
  if (sectionId) whereClause.sectionId = sectionId;
  const lessons = await prisma.lesson.findMany({
    where: whereClause,
    orderBy: { order: "asc" },
  });
  return NextResponse.json(lessons);
}

// Create a new lesson within a section
export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const body = await request.json();
  const {
    sectionId,
    title,
    description,
    type = "VIDEO",
    videoUrl,
    pdfUrl,
    thumbnailUrl,
    isPreview = false,
    isPublished = true,
    settings,
  } = body;
  // Determine order within the section
  const maxOrder = await prisma.lesson.aggregate({
    where: { sectionId },
    _max: { order: true },
  });
  const newLesson = await prisma.lesson.create({
    data: {
      courseId,
      sectionId,
      title,
      description,
      type,
      videoUrl,
      pdfUrl,
      thumbnailUrl,
      isPreview,
      isPublished,
      order: (maxOrder._max?.order ?? 0) + 1,
      settings,
      slug: `${title.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
    },
  });
  return NextResponse.json(newLesson, { status: 201 });
}

// Update an existing lesson
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const body = await request.json();
  const {
    id,
    title,
    description,
    type,
    videoUrl,
    pdfUrl,
    thumbnailUrl,
    isPreview,
    isPublished,
    order,
    settings,
  } = body;
  const updated = await prisma.lesson.update({
    where: { id },
    data: {
      title,
      description,
      type,
      videoUrl,
      pdfUrl,
      thumbnailUrl,
      isPreview,
      isPublished,
      order,
      settings,
    },
  });
  return NextResponse.json(updated);
}

// Delete a lesson
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { id } = await request.json();
  await prisma.lesson.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
