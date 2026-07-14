"use client";

import { useState, useTransition } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Mail, Lock, User, Phone, ArrowLeft, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export function SignupForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showPwd, setShowPwd] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
  });

  const update = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      // Check for referral code in URL
      const urlParams = new URLSearchParams(window.location.search);
      const refCode = urlParams.get("ref");

      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, referralCode: refCode || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast.error(data.error || "تعذّر إنشاء الحساب");
        return;
      }
      // Auto sign-in
      const signRes = await signIn("credentials", {
        email: form.email,
        password: form.password,
        redirect: false,
      });
      if (signRes?.error) {
        toast.error("تم إنشاء الحساب، يرجى تسجيل الدخول");
        router.push("/login");
        return;
      }
      toast.success("أهلاً بك في تصويرك! 🎉");
      router.push("/student");
      router.refresh();
    });
  };

  return (
    <Card className="w-full max-w-md glass border-white/40 shadow-xl rounded-2xl">
      <CardHeader className="space-y-3 text-center">
        <CardTitle className="text-3xl font-bold">ابدأ رحلتك</CardTitle>
        <CardDescription className="text-muted-foreground">
          أنشئ حساب طالب وابدأ التعلّم في دقائق
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name" className="text-sm font-medium">
              الاسم الكامل
            </Label>
            <div className="relative">
              <User className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="name"
                required
                value={form.name}
                onChange={update("name")}
                placeholder="مثال: صفاء أحمد"
                className="pr-10 rounded-xl h-11"
                disabled={pending}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email" className="text-sm font-medium">
              البريد الإلكتروني
            </Label>
            <div className="relative">
              <Mail className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={form.email}
                onChange={update("email")}
                placeholder="you@example.com"
                className="pr-10 rounded-xl h-11"
                disabled={pending}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="phone" className="text-sm font-medium">
              رقم الجوال (اختياري)
            </Label>
            <div className="relative">
              <Phone className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="phone"
                type="tel"
                value={form.phone}
                onChange={update("phone")}
                placeholder="+9665xxxxxxxx"
                className="pr-10 rounded-xl h-11"
                disabled={pending}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-sm font-medium">
              كلمة المرور
            </Label>
            <div className="relative">
              <Lock className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="password"
                type={showPwd ? "text" : "password"}
                required
                minLength={8}
                value={form.password}
                onChange={update("password")}
                placeholder="8 أحرف، حرف كبير، حرف صغير، رقم، رمز خاص"
                className="pr-10 pl-10 rounded-xl h-11"
                disabled={pending}
              />
              <button
                type="button"
                onClick={() => setShowPwd((s) => !s)}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              يجب أن تحتوي على: 8 أحرف على الأقل، حرف كبير، حرف صغير، رقم، رمز خاص
            </p>
          </div>

          <Button
            type="submit"
            disabled={pending}
            className="w-full h-11 rounded-xl brand-gradient text-white font-semibold hover:opacity-90 transition-opacity shadow-md"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "إنشاء الحساب"}
          </Button>

          <div className="text-center text-sm text-muted-foreground">
            لديك حساب بالفعل؟{" "}
            <Link
              href="/login"
              className="font-semibold text-foreground hover:underline inline-flex items-center gap-1"
            >
              سجّل الدخول
              <ArrowLeft className="h-3 w-3" />
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
