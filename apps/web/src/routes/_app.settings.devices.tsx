import type { DeviceDto } from '@hindsight/shared/dto';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/components/ui/use-toast';
import { apiDelete, apiGet } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { queryKeys } from '@/lib/queries';

import { SettingsTabs } from './_app.settings.profile';

interface DevicesResponse {
  devices: DeviceDto[];
}

export const Route = createFileRoute('/_app/settings/devices')({
  component: DevicesPage,
});

function DevicesPage() {
  const query = useQuery({
    queryKey: queryKeys.devices(),
    queryFn: () => apiGet<DevicesResponse>('/devices'),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <SettingsTabs current="devices" />

      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
          <CardDescription>
            Desktop installs registered against your account. Revoke any you don&apos;t recognize.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : query.data?.devices.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>OS</TableHead>
                  <TableHead>App version</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data.devices.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">
                      {d.deviceName}
                      {d.revokedAt && (
                        <Badge variant="destructive" className="ml-2 capitalize">
                          revoked
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="capitalize">{d.os}</TableCell>
                    <TableCell className="text-muted-foreground">{d.appVersion}</TableCell>
                    <TableCell
                      className="text-muted-foreground"
                      title={formatDateTime(d.lastSeenAt)}
                    >
                      {d.lastSeenAt ? formatRelative(d.lastSeenAt) : '—'}
                    </TableCell>
                    <TableCell>{!d.revokedAt && <RevokeDeviceButton device={d} />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">
              No devices yet. The desktop app will register here once it ships.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RevokeDeviceButton({ device }: { device: DeviceDto }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: () => apiDelete(`/devices/${device.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.devices() });
      toast({ title: 'Device revoked' });
      setOpen(false);
    },
    onError: (err) => {
      toast({
        title: 'Could not revoke',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Revoke
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {device.deviceName}?</DialogTitle>
          <DialogDescription>
            The device&apos;s token will stop working immediately. The desktop app will need to log
            in again to register a new device.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Spinner /> : 'Revoke device'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
