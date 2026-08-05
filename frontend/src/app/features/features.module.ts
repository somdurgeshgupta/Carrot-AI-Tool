import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatComponent } from './chat/chat.component';
import { AuthComponent } from './auth/auth.component';

@NgModule({
  declarations: [
    ChatComponent,
    AuthComponent
  ],
  imports: [
    CommonModule,
    FormsModule
  ],
  exports: [
    ChatComponent,
    AuthComponent
  ]
})
export class FeaturesModule { }
