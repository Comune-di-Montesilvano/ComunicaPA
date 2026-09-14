import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostalAuthorizedUser } from '../entities/postal-authorized-user.entity.js';
import { OperatorDirectoryModule } from '../operator-directory/operator-directory.module.js';
import { PostalAuthorizedUsersService } from './postal-authorized-users.service.js';
import { PostalAuthorizedUsersController } from './postal-authorized-users.controller.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PostalAuthorizedUser]), OperatorDirectoryModule],
  controllers: [PostalAuthorizedUsersController],
  providers: [PostalAuthorizedUsersService],
  exports: [PostalAuthorizedUsersService],
})
export class PostalAuthorizedUsersModule {}
