import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/orgs/$orgId/projects/$projectId/')({
  component: RouteComponent,
})

function RouteComponent() {
  return <div>Hello "/_app/orgs/$orgId/projects/$projectId/"!</div>
}
