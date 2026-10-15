import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FeedbackController, FeedbackRoutingController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

@Module({
  imports: [AuthModule],
  controllers: [FeedbackController, FeedbackRoutingController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
