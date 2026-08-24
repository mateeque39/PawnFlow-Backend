/**
 * PDF Generation - Loan Receipt Template
 * Uses jsPDF library for professional PDF generation
 */

const jsPDF = require('jspdf').jsPDF;

/**
 * Format date to MM/DD/YYYY
 */
function formatDate(dateValue) {
  if (!dateValue) return 'N/A';
  if (dateValue instanceof Date) {
    const dateObj = new Date(
      dateValue.getUTCFullYear(),
      dateValue.getUTCMonth(),
      dateValue.getUTCDate()
    );
    return dateObj.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  if (typeof dateValue === 'string') {
    try {
      const dateOnly = dateValue.match(/^\d{4}-\d{2}-\d{2}$/);
      const dateObj = dateOnly
        ? new Date(
            Number(dateValue.slice(0, 4)),
            Number(dateValue.slice(5, 7)) - 1,
            Number(dateValue.slice(8, 10))
          )
        : new Date(dateValue);
      if (!isNaN(dateObj.getTime())) {
        return dateObj.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });
      }
    } catch (e) {}
  }
  return String(dateValue);
}

/**
 * Generate professional loan receipt PDF
 * @param {Object} loan - Loan object from database
 * @returns {Promise<Buffer>} - PDF buffer
 */
async function generateLoanPDF(loan) {
  try {
    console.log('🔧 PDF Generator - Creating jsPDF receipt for loan:', loan?.id);
    
    // Validate loan object
    if (!loan) {
      console.error('   ❌ Loan object is null/undefined');
      throw new Error('Loan object is required');
    }
    if (!loan.id) {
      console.error('   ❌ Loan ID missing from loan object');
      throw new Error('Loan ID is required');
    }

    // Create PDF document
    let doc;
    try {
      doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    } catch (docErr) {
      throw new Error(`Failed to create PDF document: ${docErr.message}`);
    }

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 12;
    const labelWidth = 45;
    let y = margin;

    // ===== COMPANY HEADER =====
    doc.setFontSize(14).setFont(undefined, 'bold');
    doc.text('GREEN MOOLAA BRAMPTON', pageWidth / 2, y, { align: 'center' });
    y += 5;

    doc.setFontSize(9).setFont(undefined, 'normal');
    doc.text('263 QUEEN ST. E. UNIT 4, BRAMPTON ON L6W 4K6 | (905) 796-7777', pageWidth / 2, y, { align: 'center' });
    y += 7;

    // Divider line
    doc.setDrawColor(0);
    doc.line(margin, y, pageWidth - margin, y);
    y += 6;

    // ===== LOAN INFORMATION SECTION =====
    doc.setFontSize(10).setFont(undefined, 'bold');
    
    // Extract data - use customer_name field if available (for new loans), otherwise use first/last name from JOIN
    const firstName = String(loan.first_name || '').trim();
    const lastName = String(loan.last_name || '').trim();
    const directCustomerName = String(loan.customer_name || '').trim();
    const fullName = directCustomerName || (firstName || lastName ? `${firstName} ${lastName}`.trim() : 'N/A');
    const transactionNumber = String(loan.transaction_number || 'N/A').trim();
    const loanId = loan.id || 'N/A';
    const status = String(loan.status || 'N/A').trim().toUpperCase();
    const loanAmount = parseFloat(loan.loan_amount || 0).toFixed(2);
    
    // Try multiple fields for collateral - use whichever has data
    let collateralItem = String(loan.collateral_description || '').trim();
    if (!collateralItem) {
      collateralItem = String(loan.item_description || '').trim();
    }
    if (!collateralItem) {
      collateralItem = String(loan.item_category || '').trim();
    }
    if (!collateralItem) {
      collateralItem = 'N/A';
    }
    
    // Item description is separate - also try fallbacks
    let itemDescription = String(loan.item_description || '').trim();
    if (!itemDescription && loan.collateral_description) {
      itemDescription = String(loan.collateral_description || '').trim();
    }
    if (!itemDescription) {
      itemDescription = collateralItem;
    }
    
    const interestAmount = parseFloat(loan.interest_amount || 0).toFixed(2);
    const recurringFee = parseFloat(loan.recurring_fee || 0).toFixed(2);
    
    let loanCreated = formatDate(loan.loan_issued_date);
    let dueDate = formatDate(loan.due_date);
    
    const totalPayable = parseFloat(loan.total_payable_amount || loanAmount).toFixed(2);
    const paymentAmount = loan.payment_amount == null ? null : parseFloat(loan.payment_amount).toFixed(2);
    const paymentDate = loan.payment_date ? formatDate(loan.payment_date) : null;
    const paymentMethod = loan.payment_method || null;
    const remainingBalance = parseFloat(loan.remaining_balance || 0).toFixed(2);

    // Two-column layout for key info
    const col1 = margin;
    const col2 = margin + pageWidth / 2;
    
    doc.setFontSize(9);
    doc.text('Customer Name:', col1, y);
    doc.setFont(undefined, 'normal');
    doc.text(fullName, col1 + labelWidth, y);
    doc.setFont(undefined, 'bold');
    doc.text('Transaction No.:', col2, y);
    doc.setFont(undefined, 'normal');
    doc.text(transactionNumber, col2 + labelWidth, y);
    y += 5;

    doc.setFont(undefined, 'bold');
    doc.text('Status:', col1, y);
    doc.setFont(undefined, 'normal');
    doc.text(status, col1 + labelWidth, y);
    doc.setFont(undefined, 'bold');
    doc.text('Loan ID:', col2, y);
    doc.setFont(undefined, 'normal');
    doc.text(String(loanId), col2 + labelWidth, y);
    y += 5;

    doc.setFont(undefined, 'bold');
    doc.text('Amount:', col1, y);
    doc.setFont(undefined, 'normal');
    doc.text(`$${loanAmount}`, col1 + labelWidth, y);
    doc.setFont(undefined, 'bold');
    doc.text('Interest Amount:', col2, y);
    doc.setFont(undefined, 'normal');
    doc.text(`$${interestAmount}`, col2 + labelWidth, y);
    y += 5;

    doc.setFont(undefined, 'bold');
    doc.text('Collateral Item:', col1, y);
    doc.setFont(undefined, 'normal');
    // Use splitTextToSize for multi-line collateral item
    const maxWidth = pageWidth - col1 - labelWidth - margin;
    const collateralLines = doc.splitTextToSize(collateralItem, maxWidth);
    doc.text(collateralLines, col1 + labelWidth, y);
    y += (collateralLines.length * 4) + 1;

    doc.setFont(undefined, 'bold');
    doc.text('Item Description:', col1, y);
    doc.setFont(undefined, 'normal');
    // Use splitTextToSize for multi-line item description
    const descriptionLines = doc.splitTextToSize(itemDescription, maxWidth);
    doc.text(descriptionLines, col1 + labelWidth, y);
    y += (descriptionLines.length * 4) + 1;

    doc.setFont(undefined, 'bold');
    doc.text('Loan Created:', col1, y);
    doc.setFont(undefined, 'normal');
    doc.text(loanCreated, col1 + labelWidth, y);
    doc.setFont(undefined, 'bold');
    doc.text('Due Date:', col2, y);
    doc.setFont(undefined, 'normal');
    doc.text(dueDate, col2 + labelWidth, y);
    y += 5;

    doc.setFont(undefined, 'bold');
    doc.text('Recurring Fee:', col1, y);
    doc.setFont(undefined, 'normal');
    doc.text(`$${recurringFee}`, col1 + labelWidth, y);
    y += 8;

    if (paymentAmount !== null) {
      doc.setFont(undefined, 'bold');
      doc.text('Payment Received:', col1, y);
      doc.setFont(undefined, 'normal');
      doc.text(`$${paymentAmount}`, col1 + labelWidth, y);
      doc.setFont(undefined, 'bold');
      doc.text('Payment Date:', col2, y);
      doc.setFont(undefined, 'normal');
      doc.text(paymentDate || 'N/A', col2 + labelWidth, y);
      y += 5;

      doc.setFont(undefined, 'bold');
      doc.text('Payment Method:', col1, y);
      doc.setFont(undefined, 'normal');
      doc.text(String(paymentMethod || 'N/A').toUpperCase(), col1 + labelWidth, y);
      y += 5;

      doc.setFont(undefined, 'bold');
      doc.text('Remaining Balance:', col1, y);
      doc.setFont(undefined, 'normal');
      doc.text(`$${remainingBalance}`, col1 + labelWidth, y);
      y += 8;
    }

    // ===== TOTAL SECTION =====
    doc.setFontSize(11).setFont(undefined, 'bold');
    const totalBoxY = y;
    doc.rect(col1, totalBoxY - 2, pageWidth - 2 * margin, 8);
    doc.text('TOTAL AMOUNT DUE:', col1 + 2, y + 2);
    doc.text(`$${totalPayable}`, pageWidth - margin - 15, y + 2, { align: 'right' });
    y += 12;

    // ===== LEGAL TERMS SECTION =====
    doc.setFontSize(8).setFont(undefined, 'bold');
    doc.text('LOAN AGREEMENT TERMS:', margin, y);
    y += 4;

    doc.setFontSize(7).setFont(undefined, 'normal');
    const legalText = `I, the undersigned (herein 'the seller'), do hereby loan the item(s) above to the customer amount, the receipt of which is acknowledge by the undersigned (herein 'the Seller'), said Seller does sell, transfer, and assign all rights, title and interest in the described property to GRN. The seller declares that the above is their own personal property free and all claims and liens whatsoever and that they have the full power to sell, transfer and deliver said property as provided herein.

Seller is hereby granted a customer option by GRN to repurchase the described property from GRN at a mutually agreeable price, which is set forth on this contract. The seller has (30) days from the date of the agreement to exercise this agreement to exercise the seller option and will forfeit the option (1) days from the agreement date.`;
    
    const splitText = doc.splitTextToSize(legalText, pageWidth - 2 * margin - 2);
    doc.text(splitText, margin + 1, y);

    // ===== FOOTER =====
    doc.setFontSize(7);
    doc.setTextColor(100);
    doc.text('Pawn Receipt - GREEN MOOLAA BRAMPTON', pageWidth / 2, pageHeight - 5, { align: 'center' });

    // Return as buffer
    let pdfOutput;
    let pdfBuffer;
    try {
      pdfOutput = doc.output('arraybuffer');
      if (!pdfOutput) {
        throw new Error('doc.output() returned null/undefined');
      }
      pdfBuffer = Buffer.from(pdfOutput);
      console.log('   ✓ PDF converted to buffer, size:', pdfBuffer.length, 'bytes');
    } catch (bufErr) {
      throw new Error(`Failed to convert PDF to buffer: ${bufErr.message}`);
    }
    
    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error('PDF buffer is empty - PDF generation failed');
    }
    
    console.log('✅ PDF generated successfully, buffer size:', pdfBuffer.length);
    return pdfBuffer;
  } catch (error) {
    console.error('❌ PDF Generation Error:', error.message);
    console.error('   Loan ID:', loan?.id);
    console.error('   Customer:', `${loan?.first_name} ${loan?.last_name}`);
    throw new Error(`PDF Generation failed: ${error.message} | Loan: ${loan?.id}`);
  }
}

/**
 * Save PDF to file system (optional)
 */
async function savePDFToFile(loan, outputDir = './pdfs') {
  try {
    const fs = require('fs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filename = `loan_${loan.id}_${loan.transaction_number || 'unknown'}.pdf`;
    const filepath = `${outputDir}/${filename}`;

    const pdfBuffer = await generateLoanPDF(loan);
    fs.writeFileSync(filepath, pdfBuffer);

    console.log(`✅ PDF saved successfully: ${filepath}`);
    return filepath;
  } catch (error) {
    console.error('❌ Error saving PDF to file:', error);
    throw error;
  }
}

module.exports = {
  generateLoanPDF,
  savePDFToFile
};
