import { IsString, IsOptional, IsIn } from 'class-validator';

export class CreateSessionDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  modelId?: string;
}

export class UpdateSessionDto {
  @IsString()
  title: string;
}

export class AppendSessionMessageDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  content: string;

  @IsOptional()
  @IsString()
  modelId?: string;
}
