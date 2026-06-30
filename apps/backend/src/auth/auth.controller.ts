import { Body, Controller, Get, HttpCode, HttpStatus, Post, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import type { AuthResponseDto } from './dto/auth-response.dto';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Public } from './decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.loginWithLdap(dto);
  }

  @Public()
  @Post('citizen/login')
  @HttpCode(HttpStatus.OK)
  citizenLogin(
    @Body() dto: { codiceFiscale: string; name?: string; email?: string },
  ): Promise<{ access_token: string }> {
    return this.authService.generateCitizenToken(dto);
  }

  @Get('me')
  me(@Request() req: { user: JwtOperatorPayload }): JwtOperatorPayload {
    return req.user;
  }
}
