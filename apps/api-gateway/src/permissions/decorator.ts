/* eslint-disable prettier/prettier */
import { SetMetadata } from '@nestjs/common';
export const PermissionsApi_Key = (...permissions: string[]) => SetMetadata('permissions', permissions);