import { signup } from '../actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-3xl font-semibold tracking-tight">Start your free trial</h1>
      <p className="text-muted-foreground">14 days free. No card required.</p>
      <form action={signup} className="flex flex-col gap-4">
        <div>
          <Label htmlFor="fullName">Your name</Label>
          <Input id="fullName" name="fullName" required />
        </div>
        <div>
          <Label htmlFor="restaurantName">Restaurant name</Label>
          <Input id="restaurantName" name="restaurantName" required />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" required />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" minLength={8} required />
        </div>
        <Button type="submit" size="lg">
          Create account
        </Button>
      </form>
    </main>
  )
}
