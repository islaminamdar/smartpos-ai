import styles from './staff.module.css'

/** Guidance only: opening this panel never changes an account or sends a message. */
export default function StaffAccessHelp() {
  return (
    <details className={styles.accessHelp}>
      <summary>Need help signing in or adding a cashier?</summary>
      <div>
        <h3>Already have an account?</h3>
        <p>
          Use the email and password assigned to you. Each cashier should use their own account so
          sales and shifts are recorded under the right person.
        </p>
        <h3>Adding a new cashier</h3>
        <p>
          Give your administrator the cashier’s name, email and branch. Account setup must be
          completed before the cashier can accept a branch invitation. An invitation alone does not
          create a sign-in account.
        </p>
        <ol>
          <li>Confirm with the administrator that the cashier’s account is ready.</li>
          <li>In Staff, create an invitation for that person and share the link privately.</li>
          <li>
            The cashier opens the link on their own device and signs in to accept branch access.
          </li>
          <li>At the counter, sign in as the cashier, register the device and open their shift.</li>
        </ol>
        <h3>Forgotten password</h3>
        <p>
          Automatic password-recovery emails are not available yet. Contact your administrator for
          help. Do not create another account or share the manager’s password to work around it.
          Never send your password with a support request.
        </p>
        <h3>Before changing who is signed in</h3>
        <p>
          Finish any saved requests, close the current cashier’s shift, then sign out. If a sale is
          waiting for confirmation, keep the same browser or device and use its recovery option. Do
          not clear app or browser data to fix a sign-in problem.
        </p>
      </div>
    </details>
  )
}
