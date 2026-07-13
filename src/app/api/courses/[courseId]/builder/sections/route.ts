import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const sections = await prisma.section.findMany({
    where: { courseId },
    orderBy: { order: "asc" },
    include: { lessons: { orderBy: { order: "asc" } } },
  });
  return NextResponse.json(sections);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { courseId } = await params;
  const body = await request.json();
  const { title, titleAr, description } = body;
  const maxOrder = await prisma.section.aggregate({
    where: { courseId },
    _max: { order: true },
  });
  const newSection = await prisma.section.create({
    data: {
      courseId,
      title,
      titleAr,
      description,
      order: (maxOrder._max?.order ?? 0) + 1,
    },
  });
  return NextResponse.json(newSection, { status: 201 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const body = await request.json();
  const { id, title, titleAr, description, order } = body;
  const updated = await prisma.section.update({
    where: { id },
    data: { title, titleAr, description, order },
  });
  return NextResponse.json(updated);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const { id } = await request.json();
  await prisma.section.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
